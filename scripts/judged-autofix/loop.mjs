#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {atomic,identity,digest,Repository,safePath} from './evidence.mjs';
import {api,prepareModel,reconcileSubmission,collectModel} from './model.mjs';
import {ensureTestJob,processIdentity} from './test-job.mjs';
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const now = () => new Date().toISOString();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class JudgedLoop {
  constructor(root) {
    if(process.platform!=='linux')throw new Error('JudgedLoop requires Linux (process identity, flock, /proc)');
    this.root=path.resolve(root);this.config=read(path.join(this.root,'config.json'));
    this.repo=new Repository(this.config.repo);this.file=path.join(this.root,'state.json');
    if(!path.isAbsolute(this.config.repo)||!this.config.id||!this.config.checks)throw new Error('invalid task configuration');
    if(this.config.publish_checks!==undefined&&(!Array.isArray(this.config.publish_checks)||!this.config.publish_checks.every(n=>typeof n==='string'&&Object.prototype.hasOwnProperty.call(this.config.checks,n))))throw new Error('publish_checks must be an array of strings naming keys in checks');
    this.state=fs.existsSync(this.file)?read(this.file):{version:1,config_digest:identity(this.config),phase:'ready',rounds:[],events:[],task_nonce:randomUUID()};
    if(this.state.config_digest!==identity(this.config))throw new Error('task configuration changed');
    if(!this.state.task_nonce){this.state.task_nonce=randomUUID();this.save('task_nonce_initialized');}
  }
  save(event,detail={}){this.state.events.push({at:now(),event,...detail});atomic(this.file,this.state);}
  get round(){return this.state.rounds.at(-1);}
  directory(r=this.round){return path.join(this.root,'rounds',String(r.index));}
  assertHead(expected){if(this.repo.git(['rev-parse','HEAD'])!==expected)throw new Error('candidate HEAD drift');}
  plan(file) {
    if(this.state.blocked_test)throw new Error('surviving test process blocks planning; run recover-tests to verify recovery');
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
    const input={objective:plan.objective,judger_strategy:plan.strategy,allowed_paths:plan.allowed_paths,source_commit:base,context,previous:this.state.rounds.slice(-3).map(r=>({round:r.index,summary:r.summary,judgment:r.judgment,failure:r.failure,checks:r.receipts?.filter(x=>x.status!=='passed').map(x=>({name:x.name,status:x.status,tail:x.tail?.replace(/\x1b\[[0-9;]*m/g,'').slice(-2000)}))}))};
    if(Buffer.byteLength(JSON.stringify(input))>96000)throw new Error('context exceeds 96 KiB; narrow the Judger plan');
    const r={index,base,base_tree:tree,plan,plan_digest:identity(plan),input_digest:identity(input),input_bytes:Buffer.byteLength(JSON.stringify(input)),workflow_id:`judged-${this.config.id}-${index}-${identity({base,plan,task_nonce:this.state.task_nonce}).slice(0,8)}`,kind:'propose',state:'prepared',created_at:now()};
    this.state.rounds.push(r);atomic(path.join(this.directory(r),'input.json'),input);this.state.phase='model';this.save('judger_plan_recorded');
  }
  async step() {
    const r=this.round;if(this.state.phase!=='model')return;
    const dir=this.directory();
    if(r.state==='prepared') {
      await prepareModel(this.config,r,read(path.join(dir,'input.json')));
      r.state='submitting';atomic(path.join(dir,'request.json'),r.payload);this.save('submission_intent');
      const response=await api(this.config,'/api/runs/create-and-run',r.payload);
      if((response.run_id??response.runId)!==r.requested_run_id)throw new Error(`identity mismatch on submission: expected ${r.requested_run_id}, got ${response.run_id??response.runId}`);
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
  selectEdits(file) {
    if(this.state.blocked_test) throw new Error('surviving test process blocks selection');
    const r=this.round;
    if(this.state.phase!=='judging') throw new Error('select-edits only allowed during judging');
    if(!r.failure||r.failure.category!=='proposal') throw new Error('select-edits requires a proposal failure');
    if(r.candidate_commit) throw new Error('select-edits requires no existing candidate');
    if(r.judgment) throw new Error('select-edits requires no prior judgment');
    const sel=read(file);
    if(sel.round!==r.index) throw new Error('selection round mismatch');
    if(sel.plan_digest!==r.plan_digest) throw new Error('selection plan_digest mismatch');
    if(sel.base!==r.base) throw new Error('selection base mismatch');
    if(!sel.reason||typeof sel.reason!=='string'||!sel.reason.trim()) throw new Error('selection requires nonempty reason');
    const dir=this.directory(r);
    const proposalFile=path.join(dir,'proposal.json');
    if(!fs.existsSync(proposalFile)) throw new Error('no saved proposal to select from');
    const proposal=read(proposalFile);
    if(sel.proposal_digest!==identity(proposal)) throw new Error('proposal identity/digest mismatch');
    const edits=proposal.edits;
    if(!Array.isArray(edits)||!edits.length||edits.length>20) throw new Error('invalid saved proposal edits');
    if(Buffer.byteLength(JSON.stringify(proposal))>96000) throw new Error('proposal exceeds 96 KiB');
    const indices=sel.indices;
    if(!Array.isArray(indices)||!indices.length) throw new Error('selection requires nonempty indices');
    for(let i=0;i<indices.length;i++){
      if(!Number.isInteger(indices[i])) throw new Error('indices must be integers');
      if(indices[i]<0||indices[i]>=edits.length) throw new Error('index out of bounds');
      if(i>0&&indices[i]<=indices[i-1]) throw new Error('indices must be strictly ascending and unique');
    }
    this.assertHead(r.base);
    if(this.repo.git(['status','--porcelain','--untracked-files=normal'])) throw new Error('owned worktree must be clean');
    const selected=indices.map(i=>edits[i]);
    const current=new Map(this.repo.entries(r.base_tree).filter(f=>r.plan.allowed_paths.includes(f.path)).map(f=>[f.path,this.repo.bytes(f.sha).toString('utf8')]));
    const output=new Map();
    for(const e of selected){
      safePath(e.path);
      if(!r.plan.allowed_paths.includes(e.path)||typeof e.old!=='string'||typeof e.new!=='string') throw new Error('edit outside Judger scope');
      const source=output.has(e.path)?output.get(e.path):current.get(e.path);
      if(e.old===''){if(source!==undefined) throw new Error('empty old is only for new files');output.set(e.path,e.new);}
      else{if(source===undefined||source.split(e.old).length!==2) throw new Error(`old text must match exactly once: ${e.path}`);output.set(e.path,source.replace(e.old,()=>e.new));}
    }
    const candidate=this.repo.apply(r.base_tree,{files:[...output].map(([p,content])=>({path:p,content}))},r.plan.allowed_paths);
    if(candidate===r.base_tree) throw new Error('no source change after selection');
    const selectionDigest=identity(sel);
    const candidateCommit=this.repo.git(['commit-tree',candidate,'-p',r.base],{input:`fix: ${proposal.summary.slice(0,150)}\n\nJudged-DAG-Run: ${r.run_id}\nJudger-Selection: ${selectionDigest}\n`});
    atomic(path.join(dir,'selection.json'),sel);
    r.selection=sel;
    r.proposal_failure=r.failure;
    delete r.failure;
    r.candidate_tree=candidate;
    r.candidate_commit=candidateCommit;
    this.state.phase='apply';
    this.save('selection_applied');
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
  async test(names=this.round.plan.checks){
    const r=this.round;if(this.state.blocked_test)throw new Error('surviving test process blocks testing; run recover-tests to verify recovery');
    if(!['test','judging','accepted'].includes(this.state.phase))throw new Error('candidate unavailable for testing');
    this.assertHead(r.candidate_commit);if(this.repo.git(['status','--porcelain']))throw new Error('candidate is dirty');
    r.receipts??=[];
    const runnerDigest=digest(fs.readFileSync(new URL('./test-job.mjs',import.meta.url)));
    for(const name of names){
      const check=this.config.checks[name];if(!check)throw new Error('unknown check');
      const spec={name,repo:this.config.repo,commit:r.candidate_commit,tree:r.candidate_tree,check,home:path.join(this.root,'test-home')};
      const prior=r.receipts.find(t=>t.name===name&&t.commit===r.candidate_commit&&t.tree===r.candidate_tree&&t.spec_digest===identity(check)&&t.runner_digest===runnerDigest&&t.status==='passed'&&t.exit_code===0&&!t.signal&&fs.existsSync(t.log_path)&&digest(fs.readFileSync(t.log_path))===t.log_digest);
      if(prior)continue;
      let intent=r.test_intent;
      if(intent&&intent.name!==name)throw new Error(`pending test intent for '${intent.name}'; cannot start '${name}'`);
      if(intent){
        if(identity(intent.spec)!==identity(spec))throw new Error('test intent spec mismatch');
      } else {
        const attempt=r.receipts.length+1;
        intent={name,directory:path.join(this.directory(),`test-job-${attempt}-${name}`),spec};
        r.test_intent=intent;this.save('test_intent');
      }
      let receipt;while(true){receipt=ensureTestJob(intent.directory,intent.spec);if(receipt)break;await delay(100);}
      receipt={...receipt,job_directory:intent.directory};
      const attempt=r.receipts.length+1;
      if(receipt.status==='infrastructure_failed'&&receipt.surviving_child){
        this.state.blocked_test=receipt.surviving_child;this.state.phase='judging';
        r.receipts.push(receipt);atomic(path.join(this.directory(),`receipt-${attempt}.json`),receipt);delete r.test_intent;this.save('test_blocked',{surviving_child:receipt.surviving_child});return;
      }
      r.receipts.push(receipt);atomic(path.join(this.directory(),`receipt-${attempt}.json`),receipt);delete r.test_intent;this.save('test_recorded');
    }
    this.state.phase='judging';this.save('awaiting_judger');
  }
  assertEvidence(){
    if(this.state.blocked_test)throw new Error('blocked test process must be recovered before evidence assertion');
    if(this.round.test_intent)throw new Error('pending test intent blocks evidence assertion');
    const r=this.round;this.assertHead(r.candidate_commit);
    if(this.repo.git(['status','--porcelain']))throw new Error('candidate is dirty');
    const runnerDigest=digest(fs.readFileSync(new URL('./test-job.mjs',import.meta.url)));
    for(const name of[...r.plan.checks,...(this.config.publish_checks??[])]){
      const check=this.config.checks[name];
      if(!r.receipts?.some(t=>t.name===name&&t.tree===r.candidate_tree&&t.commit===r.candidate_commit&&t.spec_digest===identity(check)&&t.runner_digest===runnerDigest&&t.status==='passed'&&t.exit_code===0&&!t.signal&&fs.existsSync(t.log_path)&&digest(fs.readFileSync(t.log_path))===t.log_digest))
        throw new Error(`missing trusted passing receipt or evidence mismatch for ${name}`);
    }
  }
  judge(file){
    const j=read(file),r=this.round;
    if(!['accept','revise'].includes(j.verdict)||!j.reason||j.round!==r.index||j.plan_digest!==r.plan_digest)throw new Error('invalid Judger decision');
    if(this.state.phase==='accepted'){
      if(j.verdict!=='revise')throw new Error('only revise can revoke an accepted round');
      r.judgment_history??=[];r.judgment_history.push(r.judgment);
      if(this.state.publication){this.state.publication_history??=[];this.state.publication_history.push(this.state.publication);this.state.publication=undefined;}
      this.state.phase='judging';
    }else if(this.state.phase!=='judging')throw new Error('not awaiting judgment');
    if(j.verdict==='accept'){
      if(!r.candidate_commit||j.tree!==r.candidate_tree)throw new Error('Judger must bind the exact candidate');
      this.assertEvidence();
      this.state.phase='accepted';
    }
    r.judgment={...j,at:now()};atomic(path.join(this.directory(),'judgment.json'),r.judgment);this.save('judger_decision');
  }
  publish(bodyFile){
    bodyFile=path.resolve(bodyFile);
    if(this.state.phase!=='accepted')throw new Error('Judger acceptance required');
    this.assertEvidence();
    const r=this.round;
    const branch=this.repo.git(['branch','--show-current']);if(!branch.startsWith('codex/'))throw new Error('publication requires an isolated codex branch');
    const bodyBuf=fs.readFileSync(bodyFile);
    const base=this.config.base_branch??'main';
    const repo=this.config.github_repo;
    const title=this.config.pr_title;
    const intent={head:r.candidate_commit,branch,repo,base,title,body_digest:digest(bodyBuf)};
    if(this.state.publication){
      const p=this.state.publication;
      if(p.head!==intent.head||p.branch!==intent.branch||p.repo!==intent.repo||p.base!==intent.base||p.title!==intent.title||p.body_digest!==intent.body_digest)
        throw new Error('publication intent mismatch: current parameters differ from persisted intent');
    } else {
      this.state.publication=intent;this.save('publication_intent');
    }
    this.repo.git(['push','origin',`${r.candidate_commit}:refs/heads/${branch}`]);
    const gh=args=>{const x=spawnSync('gh',args,{encoding:'utf8',cwd:this.config.repo});if(x.status!==0)throw new Error(x.stderr);return x.stdout;};
    const jsonFields='url,state,headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,title,body';
    const prs=JSON.parse(gh(['pr','list','--repo',repo,'--head',branch,'--state','all','--json',jsonFields]));
    let pr;
    if(prs.length===1){pr=prs[0];}
    else if(prs.length===0){
      gh(['pr','create','--repo',repo,'--head',branch,'--base',base,'--title',title,'--body-file',bodyFile]);
      const after=JSON.parse(gh(['pr','list','--repo',repo,'--head',branch,'--state','all','--json',jsonFields]));
      if(after.length!==1)throw new Error('expected one PR after create, got '+after.length);
      pr=after[0];
    } else throw new Error('multiple PRs found for branch '+branch);
    if(pr.state!=='OPEN')throw new Error('existing PR is not OPEN');
    if(pr.headRefOid!==intent.head)throw new Error('PR headRefOid mismatch with intent');
    if(pr.headRefName!==intent.branch)throw new Error('PR headRefName mismatch');
    if(pr.baseRefName!==intent.base)throw new Error('PR baseRefName mismatch');
    const repoJoin=`${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`.toLowerCase();
    if(repoJoin!==repo.toLowerCase())throw new Error('PR headRepository mismatch with config repo');
    if(pr.title!==intent.title)throw new Error('PR title mismatch');
    if(digest(Buffer.from(pr.body))!==intent.body_digest)throw new Error('PR body digest mismatch');
    this.state.publication.url=pr.url;this.save('published');return pr.url;
  }
  recoverTests(){
    if(!this.state.blocked_test)throw new Error('no blocked test to recover');
    const{pid,start}=this.state.blocked_test;const current=processIdentity(pid);
    if(current!==null&&(start===null||String(current)===String(start)))throw new Error('surviving process still alive; wait for completion before recovery');
    delete this.state.blocked_test;this.state.phase='judging';this.save('recovery_verified');
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [root,op,...args]=process.argv.slice(2);if(!root||!op)throw new Error('Usage: loop.mjs <task-directory> plan|step|select-edits|apply|test|judge|publish|recover-tests|status [file/check]');
  if(!process.env.HR_JUDGED_LOCKED){const r=spawnSync('flock',['-n',path.join(root,'lock'),process.execPath,fileURLToPath(import.meta.url),root,op,...args],{env:{...process.env,HR_JUDGED_LOCKED:'1'},stdio:'inherit'});process.exit(r.status??1);}
  const loop=new JudgedLoop(root);
  try{if(op==='plan')loop.plan(args[0]);else if(op==='step')await loop.step();else if(op==='select-edits')loop.selectEdits(args[0]);else if(op==='apply')loop.apply();else if(op==='test')await loop.test(args.length?args:undefined);else if(op==='judge')loop.judge(args[0]);else if(op==='publish')loop.publish(args[0]);else if(op==='recover-tests')loop.recoverTests();else if(op!=='status')throw new Error('unknown operation');}
  catch(e){loop.save('controller_error',{message:e.message});console.error(e.message);process.exitCode=1;}
  console.log(JSON.stringify({phase:loop.state.phase,round:loop.round?.index,run_id:loop.round?.run_id,failure:loop.round?.failure,checks:loop.round?.receipts?.map(x=>({name:x.name,status:x.status})),publication:loop.state.publication}));
}

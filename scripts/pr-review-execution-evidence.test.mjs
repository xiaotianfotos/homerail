import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const runId='run-audit-1';
const slots={qwen_review:'qwen',kimi_review:'kimi',glm_review:'glm'};
const prompt=(node,provider='glm',model='glm-5.3',stamp=1)=>({role:'manager',type:'prompt',timestamp:stamp,content:{runId,nodeId:node,sessionId:`session-${node}`,agentConfig:{agent_type:'claude-sdk',llm_setting_id:`setting-${node}`,llm:{provider,model,api_key:'NEVER_PUBLISH_SECRET',base_url:'https://user:password@example.test/api?key=SECRET'}}}});
const usage=(node,id,u,extra={},stamp=2)=>({role:'worker',type:'response',timestamp:stamp,content:{type:'usage',event:'usage',run_id:runId,node_id:node,session_id:`session-${node}`,execution_id:id,usage:u,...extra}});
const u=(input=10,output=5,cached=2)=>({input_tokens:input,output_tokens:output,cache_read_input_tokens:cached,cache_creation_input_tokens:0});
async function mod(){return import('./pr-review-execution-evidence.mjs');}
function baseChats(){return Object.fromEntries(Object.keys(slots).map(n=>[n,[prompt(n,n==='kimi_review'?'kimi_cn':'glm',n==='kimi_review'?'k3':'glm-5.3'),usage(n,n,u(),{finish_reason:'completed',duration_ms:100})]]));}

test('reports Manager-resolved model identity, not model-authored slot names or setting diversity',async()=>{
 const {buildPrReviewExecutionEvidence}=await mod();const chats=baseChats();
 chats.qwen_review.push({role:'worker',type:'response',content:{reviewer:'qwen',provider:'qwen',model:'qwen',text:'NEVER_PUBLISH_PROMPT'}});
 const evidence=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});
 assert.equal(evidence.schema,'pr-review-execution-evidence-v1');assert.equal(evidence.run_id,runId);assert.equal(evidence.quorum_basis,'reviewer_executions');
 assert.equal(evidence.distinct_model_identities,2);assert.equal(evidence.provenance_complete,true);
 const q=evidence.reviewers.find(r=>r.node_id==='qwen_review');assert.equal(q.slot,'qwen');assert.deepEqual(q.dispatches[0].binding,{provider:'glm',model:'glm-5.3',backend:'claude-sdk',setting_id:'setting-qwen_review'});
 assert.doesNotMatch(JSON.stringify(evidence),/NEVER_PUBLISH|password|example\.test|api_key|base_url/);
});

test('deduplicates cumulative snapshots, final settlement may arrive after terminal handoff',async()=>{
 const {buildPrReviewExecutionEvidence}=await mod();const chats=baseChats();const n='qwen_review';
 chats[n]=[prompt(n),usage(n,'exec1',u(10,5,2)),usage(n,'exec1',u(10,5,2)),{role:'worker',type:'response',content:{type:'node_handoff',run_id:runId,node_id:n}},usage(n,'exec1',u(20,8,4),{finish_reason:'completed',duration_ms:160},9),usage(n,'exec1',u(10,5,2),{},3)];
 const e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});const q=e.reviewers.find(r=>r.node_id===n);
 assert.equal(q.executions.length,1);assert.equal(q.executions[0].usage_state,'final');assert.deepEqual(q.executions[0].usage,u(20,8,4));assert.equal(e.usage_state,'final');assert.equal(e.observed_tokens,32+17+17);
});

test('fresh correction adds an execution and preserves unknown or partial accounting',async()=>{
 const {buildPrReviewExecutionEvidence}=await mod();const chats=baseChats(),n='qwen_review';
 chats[n].push(prompt(n,'glm','glm-5.3',3),usage(n,'correction',u(12,3,4),{},4));
 let e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});assert.equal(e.usage_state,'partial');assert.equal(e.observed_tokens,70);assert.equal(e.reviewers.find(r=>r.node_id===n).executions.length,2);
 chats[n].push(prompt(n,'glm','glm-5.3',5));e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});assert.equal(e.usage_state,'partial');assert.equal(e.reviewers.find(r=>r.node_id===n).unaccounted_dispatches,1);
 const noUsage=Object.fromEntries(Object.keys(slots).map(n=>[n,[prompt(n)]]));e=buildPrReviewExecutionEvidence({runId,chatsByNode:noUsage});assert.equal(e.usage_state,'unknown');assert.equal(e.observed_tokens,null);
});

test('missing chat and malformed or stale usage cannot become complete zero-cost execution',async()=>{
 const {buildPrReviewExecutionEvidence}=await mod();const chats=baseChats();chats.kimi_review=null;
 chats.qwen_review=[prompt('qwen_review'),usage('qwen_review','bad',u(-1,2,0)),usage('qwen_review','stale',u(900,900,900),{run_id:'other-run'}),usage('qwen_review','wrong-session',u(900,900,900),{session_id:'old-session'})];
 const e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});assert.equal(e.provenance_complete,false);assert.equal(e.usage_state,'partial');assert.equal(e.observed_tokens,17);assert.equal(e.reviewers.find(r=>r.node_id==='kimi_review').availability,'unavailable');
 const empty=buildPrReviewExecutionEvidence({runId,chatsByNode:{}});assert.equal(empty.usage_state,'unknown');assert.equal(empty.observed_tokens,null);
});

test('immutable persisted dispatch history survives changed live setting configuration and replay',async()=>{
 const {buildPrReviewExecutionEvidence}=await mod();const chats=baseChats(),before=JSON.stringify(chats);
 const e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});const replay=JSON.parse(before);assert.deepEqual(buildPrReviewExecutionEvidence({runId,chatsByNode:replay}),e);assert.equal(JSON.stringify(chats),before);
 // A later dispatch really changing identity must remain visible, not replace history.
 replay.qwen_review.push(prompt('qwen_review','qwen','new-model',3));const changed=buildPrReviewExecutionEvidence({runId,chatsByNode:replay});assert.equal(changed.distinct_model_identities,3);assert.equal(changed.reviewers[0].dispatches.length,2);
});

test('collector writes bounded allowlisted evidence even if a degraded reviewer chat is unavailable',async()=>{
 const {collectPrReviewExecutionEvidence}=await mod();const requested=[];const server=http.createServer((req,res)=>{requested.push(req.url);res.setHeader('content-type','application/json');const node=Object.keys(slots).find(n=>req.url.endsWith(`/node/${n}/chat`));if(node==='kimi_review'){res.statusCode=503;res.end(JSON.stringify({success:false,message:'DO_NOT_LEAK_SERVER_ERROR'}));return;}res.end(JSON.stringify({success:true,data:{messages:baseChats()[node]??[]}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-audit-'));
 try{const file=path.join(dir,'evidence.json');const e=await collectPrReviewExecutionEvidence({managerUrl:`http://127.0.0.1:${server.address().port}`,runId,outputPath:file});assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),e);assert.equal(requested.length,3);assert.equal(e.provenance_complete,false);assert.equal(e.usage_state,'partial');assert.doesNotMatch(fs.readFileSync(file,'utf8'),/DO_NOT_LEAK|NEVER_PUBLISH/);}
 finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('partial metadata from separate snapshots cannot synthesize final settlement',async()=>{
 const {buildPrReviewExecutionEvidence}=await mod();const chats=baseChats();const n='qwen_review';chats[n]=[prompt(n),usage(n,'exec',u(),{finish_reason:'completed'},2),usage(n,'exec',u(),{duration_ms:100},3)];
 const e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});assert.equal(e.reviewers[0].executions[0].usage_state,'partial');assert.equal(e.usage_state,'partial');
});

test('missing resolved binding remains an unaccounted dispatch instead of disappearing',async()=>{
 const {buildPrReviewExecutionEvidence}=await mod();const chats=baseChats();const m=prompt('qwen_review','glm','glm-5.3',3);delete m.content.agentConfig.llm;chats.qwen_review.push(m);
 const e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});assert.equal(e.provenance_complete,false);assert.equal(e.usage_state,'partial');assert.equal(e.reviewers[0].unaccounted_dispatches,1);
});

test('safe IDs, single-fence execution attribution and complete prompt replay deduplication',async()=>{
 const {buildPrReviewExecutionEvidence}=await mod();assert.throws(()=>buildPrReviewExecutionEvidence({runId:'../bad',chatsByNode:{}}),/runId/);
 const chats=baseChats();const n='qwen_review';const replay=prompt(n);const changed=prompt(n,'other','model',1);chats[n].splice(1,0,changed,replay);let e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});assert.equal(e.reviewers[0].dispatches.length,2);
 const next=prompt(n,'glm','glm-5.3',3);next.content.sessionId='next-session';chats[n]=[...baseChats()[n],next,usage(n,n,u(900,900,900),{session_id:'next-session'},4)];e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});assert.equal(e.observed_tokens,51);assert.equal(e.usage_state,'partial');
 chats[n]=[prompt(n),usage(n,'x'.repeat(257),u(900,900,900))];e=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});assert.equal(e.observed_tokens,34);
});

test('collector uses the established Manager header without following credential-bearing redirects',async()=>{
 const {collectPrReviewExecutionEvidence}=await mod();let auth;const old=process.env.HOMERAIL_DAG_MUTATION_TOKEN;process.env.HOMERAIL_DAG_MUTATION_TOKEN='test-audit-token';const server=http.createServer((req,res)=>{auth=req.headers;res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data:{messages:[]}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-audit-auth-'));
 try{await collectPrReviewExecutionEvidence({managerUrl:`http://127.0.0.1:${server.address().port}/`,runId,outputPath:path.join(dir,'evidence.json')});assert.equal(auth['x-homerail-dag-token'],'test-audit-token');assert.equal(auth.authorization,undefined);}
 finally{if(old===undefined)delete process.env.HOMERAIL_DAG_MUTATION_TOKEN;else process.env.HOMERAIL_DAG_MUTATION_TOKEN=old;await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('rendered report labels execution quorum and actual bindings, missing accounting remains explicit',async()=>{
 const {renderPrReviewMarkdown}=await import('./render-pr-review-markdown.mjs');const {buildPrReviewExecutionEvidence}=await mod();const chats=baseChats();chats.kimi_review=null;
 const audit=buildPrReviewExecutionEvidence({runId,chatsByNode:chats});
 const report={repo:'org/repo',pr:1,base:'a'.repeat(40),head:'b'.repeat(40),status:'pass',confidence:'medium',actionable_count:0,summary:'Two approve, one abstains',findings:[],reviewer_results:[{reviewer:'qwen',status:'complete',vote:'approve',summary:'ok'},{reviewer:'kimi',status:'failed',vote:'abstain',summary:'incomplete'},{reviewer:'glm',status:'complete',vote:'approve',summary:'ok'}]};
 const publication={report,quorum:{passed:true,successes:2,total:3,threshold:2}};
 const md=renderPrReviewMarkdown({run_id:runId},publication,audit);assert.match(md,/reviewer executions/);assert.match(md,/glm\/glm-5\.3/);assert.match(md,/claude-sdk/);assert.match(md,/partial/);assert.match(md,/unavailable/);assert.doesNotMatch(md,/NEVER_PUBLISH|## Model votes/);
 assert.throws(()=>renderPrReviewMarkdown({run_id:runId},publication,{...audit,run_id:'other'}),/run.*mismatch/);
 const missing=renderPrReviewMarkdown({run_id:runId},publication);assert.match(missing,/unavailable|not available/);assert.doesNotMatch(missing,/## Model votes/);
});

test('stable runner collects sanitized execution evidence on both successful quorum and command failure',async()=>{
 const {spawn}=await import('node:child_process');
 const requests=[];const server=http.createServer((req,res)=>{requests.push(req.url);res.setHeader('content-type','application/json');const node=Object.keys(slots).find(n=>req.url.endsWith(`/node/${n}/chat`));res.end(JSON.stringify({success:true,data:{messages:baseChats()[node]??[]}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stable-review-audit-'));
 try{
  const scripts=path.join(dir,'scripts');fs.mkdirSync(path.join(scripts,'lib'),{recursive:true});
  for(const f of ['run-stable-dag-runner.sh','render-pr-review-markdown.mjs','pr-review-execution-evidence.mjs'])fs.copyFileSync(new URL(f,import.meta.url),path.join(scripts,f));
  fs.writeFileSync(path.join(scripts,'configure-pr-review-runtime-profile.mjs'),"process.stdout.write('test-profile');\n");
  fs.writeFileSync(path.join(scripts,'validate-pr-review-artifacts.mjs'),'process.exit(0);\n');
  fs.writeFileSync(path.join(scripts,'lib/stable-automation-runtime.sh'),`initialize_stable_automation_runtime() { HOMERAIL_STABLE_RELEASE="$HOMERAIL_TEST_RELEASE"; HOMERAIL_STABLE_NODE="$HOMERAIL_TEST_NODE"; HOMERAIL_STABLE_REVISION=test; }
stable_hr() {
 if [ "$1" = "--json" ]; then
  if [ "$HOMERAIL_TEST_MODE" = "failure" ]; then return 1; fi
  printf '%s\\n' '{"run_id":"${runId}","status":"completed"}'; return 0
 fi
 if [ "$1" = "dag" ] && [ "$2" = "artifact" ]; then
  cp "$HOMERAIL_TEST_PUBLICATION" "$6"; return 0
 fi
 return 0
}
`);
  const report={repo:'org/repo',pr:1,base:'a'.repeat(40),head:'b'.repeat(40),status:'pass',confidence:'medium',actionable_count:0,summary:'Two approve, one abstains',findings:[],reviewer_results:[{reviewer:'qwen',status:'complete',vote:'approve',summary:'ok'},{reviewer:'kimi',status:'failed',vote:'abstain',summary:'incomplete'},{reviewer:'glm',status:'complete',vote:'approve',summary:'ok'}]};
  const publication=path.join(dir,'publication.json');fs.writeFileSync(publication,JSON.stringify({report,quorum:{passed:true,successes:2,total:3,threshold:2}}));
  for(const mode of ['success','failure']){
   const artifacts=path.join(dir,mode);const before=requests.length;
   const env={...process.env,HOMERAIL_TEST_RELEASE:dir,HOMERAIL_TEST_NODE:process.execPath,HOMERAIL_TEST_MODE:mode,HOMERAIL_TEST_PUBLICATION:publication,HOMERAIL_STABLE_TASK:'pr-review',HOMERAIL_STABLE_RUN_ID:runId,HOMERAIL_PR_REVIEW_INPUT:'{}',HOMERAIL_PR_REVIEW_INPUT_FILE:'',HOMERAIL_PR_REVIEW_ARTIFACT_DIR:artifacts,HOMERAIL_MANAGER_URL:`http://127.0.0.1:${server.address().port}`};
   const child=spawn('bash',[path.join(scripts,'run-stable-dag-runner.sh')],{env});let stderr='';child.stderr.on('data',c=>stderr+=c);child.stdout.resume();const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
   assert.equal(code,mode==='success'?0:1,stderr);assert.equal(requests.length-before,3,`${mode} must collect all slots`);
   const e=JSON.parse(fs.readFileSync(path.join(artifacts,'pr-review-execution.json'),'utf8'));assert.equal(e.run_id,runId);assert.equal(e.distinct_model_identities,2);assert.doesNotMatch(JSON.stringify(e),/NEVER_PUBLISH_SECRET/);
   if(mode==='success')assert.match(fs.readFileSync(path.join(artifacts,'pr-review.md'),'utf8'),/glm\/glm-5\.3/);
  }
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

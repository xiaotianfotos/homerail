import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {GraphExecutor} from '../src/orchestration/graph-executor.js';
import {parseWorkflowSource} from '../src/orchestration/workflow-spec-v1.js';
import {FakeDAGDispatcher,type DAGDispatcher} from '../src/orchestration/dag-dispatcher.js';
import {closeDb} from '../src/persistence/db.js';
import {loadRunSnapshot} from '../src/persistence/store.js';
import {_clearActiveRuns,getActiveRun} from '../src/runtime/active-runs.js';

let home:string;
let prior:Record<string,string|undefined>;
beforeEach(()=>{
 prior=Object.fromEntries(['HOMERAIL_HOME','HOMERAIL_DAG_COMMAND_ALLOWLIST','HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS'].map(k=>[k,process.env[k]]));
 home=fs.mkdtempSync(path.join(os.tmpdir(),'homerail-failure-drain-'));process.env.HOMERAIL_HOME=home;process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST='node';process.env.HOMERAIL_DAG_ALLOW_DYNAMIC_COMMANDS='true';closeDb();_clearActiveRuns();
});
afterEach(()=>{_clearActiveRuns();closeDb();for(const [k,v] of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}fs.rmSync(home,{recursive:true,force:true});});
function workflow(){return parseWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata: {id: failure-drain, name: Failure drain}
spec:
  contracts: {Task: {type: object}}
  agents: {actor: {system: Fixture only}}
  nodes:
    actor:
      kind: agent
      agent: actor
      inputs: {task: {contract: Task}}
      outputs: {done: {}, failed: {}}
    recover:
      kind: command
      inputs: {reason: {}}
      outputs: {recovered: {}, failed: {}}
      config:
        command: [node, -e, 'console.log(JSON.stringify({recovered:true}))']
        timeout_ms: 5000
        success_port: recovered
        failure_port: failed
        parse_stdout: json
        result_payload: value
    direct_done: {kind: terminal, outcome: success, inputs: {result: {}}}
    done: {kind: terminal, outcome: success, inputs: {result: {}}}
    failed: {kind: terminal, outcome: failure, inputs: {result: {}}}
  edges:
    - {from: $run.input, to: actor.task}
    - {from: actor.done, to: direct_done.result}
    - {from: actor.failed, to: recover.reason, condition: on_failure}
    - {from: recover.recovered, to: done.result}
    - {from: recover.failed, to: failed.result, condition: on_failure}
`);}

it('drains a newly READY failure handler after runtime binding rejection with zero model dispatches',()=>{
 const parsed=workflow();parsed.meta.agents!.actor={...parsed.meta.agents!.actor,agent_type:'claude-sdk',llm_setting_id:'does-not-exist'};
 const dispatcher=new FakeDAGDispatcher();const executor=new GraphExecutor(dispatcher);executor.createRun('binding-reject',parsed,'{}');
 expect.soft(executor.tick('binding-reject')).toBe(1);
 expect(dispatcher.dispatched).toHaveLength(0);expect(getActiveRun('binding-reject')?.counters.dispatches).toBe(0);
 expect(getActiveRun('binding-reject')?.dagRun.nodeStates.get('actor')).toBe('FAILED');expect(getActiveRun('binding-reject')?.dagRun.nodeStates.get('recover')).toBe('COMPLETED');expect(getActiveRun('binding-reject')?.status).toBe('completed');
 const before=JSON.stringify(loadRunSnapshot('binding-reject')?.handoffs);expect(executor.tick('binding-reject')).toBe(0);expect(JSON.stringify(loadRunSnapshot('binding-reject')?.handoffs)).toBe(before);
});

it('drains a nonretryable dispatch failure without replaying dispatch or recovery side effects',()=>{
 const parsed=workflow();parsed.meta.agents!.actor={...parsed.meta.agents!.actor,agent_type:'deterministic'};
 const dispatch=vi.fn(()=>({status:'failed' as const,reason:'no compatible worker',retryable:false}));const executor=new GraphExecutor({dispatch} satisfies DAGDispatcher);executor.createRun('dispatch-reject',parsed,'{}');
 expect.soft(executor.tick('dispatch-reject')).toBe(1);expect(dispatch).toHaveBeenCalledTimes(1);expect(getActiveRun('dispatch-reject')?.counters.dispatches).toBe(1);expect(getActiveRun('dispatch-reject')?.status).toBe('completed');expect(executor.tick('dispatch-reject')).toBe(0);expect(dispatch).toHaveBeenCalledTimes(1);
});

it('stops immediately at unchanged capacity-blocked READY nodes without spinning',()=>{
 const parsed=workflow();parsed.meta.agents!.actor={...parsed.meta.agents!.actor,agent_type:'deterministic'};
 const dispatch=vi.fn(()=>({status:'skipped' as const,reason:'waiting for capacity'}));const executor=new GraphExecutor({dispatch} satisfies DAGDispatcher);executor.createRun('capacity-wait',parsed,'{}');
 expect(executor.tick('capacity-wait')).toBe(0);expect(dispatch).toHaveBeenCalledTimes(1);expect(getActiveRun('capacity-wait')?.status).toBe('active');expect(getActiveRun('capacity-wait')?.dagRun.nodeStates.get('actor')).toBe('READY');expect(getActiveRun('capacity-wait')?.dagRun.nodeStates.get('recover')).toBe('PENDING');
});

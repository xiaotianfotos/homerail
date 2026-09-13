// Integration fixture: real, unchanged Manager routes + GraphExecutor, no models.
// Requires the repository's already-built Manager packages. Not an observer dependency.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error('absolute isolated fixture root required');
process.env.HOMERAIL_HOME = root;
process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = process.execPath.toLowerCase();
const { GraphExecutor } = await import('../../../homerail_manager/dist/orchestration/graph-executor.js');
const { FakeDAGDispatcher } = await import('../../../homerail_manager/dist/orchestration/dag-dispatcher.js');
const { parseWorkflowSource } = await import('../../../homerail_manager/dist/orchestration/workflow-spec-v1.js');
const { inspectionRoutesHandler } = await import('../../../homerail_manager/dist/server/routes.js');
const server = http.createServer((req, res) => {
  if (!inspectionRoutesHandler(req, res)) { res.writeHead(404); res.end(); }
});
const executor = new GraphExecutor(new FakeDAGDispatcher());
const command = `const fs=require('fs');fs.appendFileSync('count','x');const t=setInterval(()=>{
if(fs.existsSync('release')){clearInterval(t);console.log(JSON.stringify({executed:true}));}},50);`;
const workflow = { api_version: 'homerail.ai/v1', kind: 'Workflow', metadata: { id: 'skill-listener-test', name: 'Skill listener test' }, spec: {
  agents: {}, contracts: { Task: { type: 'string' } }, nodes: {
    work: { kind: 'command', inputs: { task: { contract: 'Task' } }, outputs: { ready: {}, failed: {} },
      config: { command: [process.execPath, '-e', command], cwd: '$run_workspace', durable: true,
        timeout_ms: 120000, success_port: 'ready', failure_port: 'failed', parse_stdout: 'json', result_payload: 'value' } },
    done: { kind: 'terminal', outcome: 'success', inputs: { result: {} } },
    failed: { kind: 'terminal', outcome: 'failure', inputs: { result: {} } },
  }, edges: [{ from: '$run.input', to: 'work.task' }, { from: 'work.ready', to: 'done.result' },
    { from: 'work.failed', to: 'failed.result', condition: 'on_failure' }] } };
executor.createRun('skill-listener-proof', parseWorkflowSource(JSON.stringify(workflow)), JSON.stringify('deterministic fixture'));
executor.tick('skill-listener-proof');
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({
    pid: process.pid, manager_url: `http://127.0.0.1:${server.address().port}`, run_id: 'skill-listener-proof',
  }));
});

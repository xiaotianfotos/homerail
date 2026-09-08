import fs from 'node:fs';
import { atomic, identity } from './evidence.mjs';

export async function api(plan, route, body, raw = false) {
  const r = await fetch(plan.manager_url.replace(/\/$/, '') + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-homerail-dag-token': process.env.HOMERAIL_DAG_MUTATION_TOKEN ?? '' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Manager ${route}: HTTP ${r.status} ${text.slice(0, 300)}`);
  if (raw) return text;
  const value = JSON.parse(text); if (value.success === false) throw new Error(value.error ?? value.message);
  return value.data ?? value;
}
export function workflow(id, kind) {
  const coder = kind === 'propose';
  const contract = {type:'object',additionalProperties:false,required:['edits','summary'],properties:{edits:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,required:['path','old','new'],properties:{path:{type:'string'},old:{type:'string',maxLength:30000},new:{type:'string',maxLength:50000}}}},summary:{type:'string',maxLength:1500}}};
  return { api_version: 'homerail.ai/v1', kind: 'Workflow', metadata: { id, name: id }, spec: {
    workspace: { mode: 'isolated' }, contracts: { Task: { type: 'object' }, Result: contract },
    agents: {actor:{system:'You implement the Judger-authored repair plan exactly. You do not choose the repair strategy, approve your own work, run tests or publish. This is a fresh session: all needed source/evidence is in the current input. Return surgical exact-text replacements as handoff(result) content {edits:[{path,old,new}],summary}. Each old string must occur exactly once in the supplied current source. Empty old creates a new file only. Use actual newline characters, not literal backslash-n. Keep changes within allowed_paths and preserve unrelated code. If a plan cannot be followed, explain the concrete obstacle rather than inventing APIs. Put edits AND summary inside the tool content object, never inside a JSON-encoded string. The trusted runner executes tests and the external Judger decides acceptance.'}},
    nodes: {
      actor: { kind: 'agent', agent: 'actor', session_scope: 'dispatch', allowed_builtin_tools: [], allowed_dag_tools: ['handoff'], inputs: { task: { contract: 'Task' } }, outputs: { result: { contract: 'Result' } } },
      done: { kind: 'terminal', outcome: 'success', inputs: { result: {} } },
    }, edges: [{ from: '$run.input', to: 'actor.task' }, { from: 'actor.result', to: 'done.result' }],
    artifacts: [{ name: 'result.json', source: { type: 'handoff', node: 'actor', port: 'result' }, media_type: 'application/json', contract: 'Result', required: true, publish: 'always' }],
    policies: { max_dispatches: 3, max_corrections_per_node: 1 },
  } };
}
export async function prepareModel(plan, attempt, input) {
  const w = workflow(attempt.workflow_id, attempt.kind);
  const wf = await api(plan, '/api/dag/workflows/sync', { yaml_text: JSON.stringify(w), source_path: `judged-autofix:${attempt.workflow_id}` });
  const profile = { profile_id: attempt.workflow_id, workflow_id: attempt.workflow_id, default: { llm_setting_id: plan.setting_id, agent_type: 'deepseek_harness', reasoning_effort: plan.reasoning_effort ?? 'low' } };
  const pr = await api(plan, '/api/dag/profiles/sync', { yaml_text: JSON.stringify(profile), workflow_id: attempt.workflow_id, source_path: 'judged-autofix' });
  const workflow_revision = wf.workflow?.head_revision;
  const canonical_hash = wf.workflow?.canonical_hash;
  const profile_updated_at = pr.profile?.updated_at;
  if (!Number.isInteger(workflow_revision) || workflow_revision <= 0) throw new Error('invalid workflow revision');
  if (typeof canonical_hash !== 'string' || !/^[0-9a-f]{64}$/.test(canonical_hash)) throw new Error('invalid canonical hash');
  if (typeof profile_updated_at !== 'string' || !profile_updated_at) throw new Error('invalid profile updated_at');
  attempt.requested_run_id = identity(attempt.workflow_id).slice(0, 24);
  attempt.payload = { runId: attempt.requested_run_id, workflow_id: attempt.workflow_id, profile: attempt.workflow_id, prompt: JSON.stringify(input), workflow_revision, canonical_hash, profile_updated_at };
}
export async function reconcileSubmission(plan, attempt) {
  const result = await api(plan, '/api/runs/create-and-run', attempt.payload);
  const runId = result.run_id ?? result.runId;
  if (runId !== attempt.requested_run_id) throw new Error(`identity mismatch: expected ${attempt.requested_run_id}, got ${runId}`);
  return runId;
}
export async function collectModel(plan, attempt, directory) {
  const status = await api(plan, `/api/runs/${attempt.run_id}/status`);
  atomic(`${directory}/status.json`, status);
  if (!status.terminal) return null;
  const chat = await api(plan, `/api/dag-status/${attempt.run_id}/node/actor/chat`);
  atomic(`${directory}/chat.json`, chat);
  const latest = new Map(); let tools = 0;
  for (const m of chat.messages ?? []) {
    const c = m.content;
    if (c?.type === 'usage') latest.set(c.execution_id ?? 'actor', c.usage);
    if (c?.type === 'tool_use') tools++;
  }
  const tokens = [...latest.values()].reduce((n, u) => n + ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((a, k) => a + (u[k] ?? 0), 0), 0);
  attempt.metrics = { run_seconds: (Date.parse(status.completed_at) - Date.parse(status.created_at)) / 1000, tokens: tokens || null, usage: [...latest.values()], tool_calls: tools, corrections: status.counters?.corrections, terminal: status.status };
  const artifacts = await api(plan, `/api/runs/${attempt.run_id}/artifacts`);
  const result = artifacts.artifacts?.find(a => a.name === 'result.json' && a.status === 'ready');
  if (result) {
    const text = await api(plan, `/api/runs/${attempt.run_id}/artifacts/result.json/content`, undefined, true);
    fs.writeFileSync(`${directory}/result.json`, text);
    if (status.status !== 'completed') return { failed: true, status: status.status, failure: { category: 'model_terminal', status: status.status, code: 'run_not_completed', message: `terminal run status ${status.status} cannot yield a valid proposal` } };
    try { return { value: JSON.parse(text) }; }
    catch (e) { if (e instanceof SyntaxError) return { failed: true, status: 'completed', failure: { category: 'model_result', status: 'completed', code: 'invalid_result_json', message: 'result artifact is not valid JSON' } }; throw e; }
  }
  if (status.status === 'completed') return { failed: true, status: 'completed', failure: { category: 'model_result', status: 'completed', code: 'missing_result_artifact', message: 'completed run has no ready result artifact' } };
  return { failed: true, status: status.status, failure: { category: 'model_terminal', status: status.status, code: 'run_not_completed', message: `terminal run status ${status.status} produced no result artifact` } };
}

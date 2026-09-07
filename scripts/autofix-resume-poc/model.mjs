import fs from 'node:fs';
import { atomic, identity } from './core.mjs';

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
  const contract = coder ? {
    type: 'object', additionalProperties: false, required: ['files', 'summary'], properties: {
      files: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string', maxLength: 65536 } } } },
      summary: { type: 'string', minLength: 1, maxLength: 1500 },
    },
  } : { type: 'object', additionalProperties: false, required: ['verdict', 'findings'], properties: { verdict: { type: 'string', enum: ['clean', 'changes_requested'] }, findings: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 1000 } } } };
  return { api_version: 'homerail.ai/v1', kind: 'Workflow', metadata: { id, name: id }, spec: {
    workspace: { mode: 'isolated' }, contracts: { Task: { type: 'object' }, Result: contract },
    agents: { actor: { system: coder
      ? 'You implement a bounded code repair. The task input contains the immutable objective, current files, trusted test failure, and past failed approaches. Read that evidence; do not repeat a failed proposal. Modify only writable_paths. Return full UTF-8 file contents only for changed files. Preserve unrelated working behavior. Your first and only tool is handoff on port result with content {files:[{path,content}],summary}. Do not claim tests ran; a separate trusted executor tests your proposal. Do not return markdown fences or a JSON-encoded string.'
      : 'Fresh semantic review. Check the objective against actual supplied source, test coverage and trusted execution evidence. Consider boundary cases and weakening of acceptance. Do not invent executed tests. First and only tool: handoff on result with content {verdict:"clean" or "changes_requested",findings:[specific actionable defects]}. clean requires empty findings; changes_requested requires at least one.' } },
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
  await api(plan, '/api/dag/workflows/sync', { yaml_text: JSON.stringify(w), source_path: `autofix-resume-poc:${attempt.workflow_id}` });
  const profile = { profile_id: attempt.workflow_id, workflow_id: attempt.workflow_id, default: { llm_setting_id: plan.setting_id, agent_type: 'deepseek_harness', reasoning_effort: plan.reasoning_effort ?? 'low' } };
  await api(plan, '/api/dag/profiles/sync', { yaml_text: JSON.stringify(profile), workflow_id: attempt.workflow_id, source_path: 'autofix-resume-poc' });
  attempt.requested_run_id = identity(attempt.workflow_id).slice(0, 24);
  attempt.payload = { runId: attempt.requested_run_id, workflow_id: attempt.workflow_id, profile: attempt.workflow_id, prompt: JSON.stringify(input) };
}
export async function reconcileSubmission(plan, attempt) {
  const listed = await api(plan, '/api/runs?limit=1000');
  const matches = (listed.runs ?? []).filter(r => r.workflowId === attempt.workflow_id && r.runId === attempt.requested_run_id);
  if (matches.length > 1) throw new Error('ambiguous model submission: multiple runs');
  return matches[0]?.runId;
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
  if (!result) {
    if (status.status === 'completed') throw new Error('completed run missing declared result artifact');
    return { failed: true, status: status.status };
  }
  const text = await api(plan, `/api/runs/${attempt.run_id}/artifacts/result.json/content`, undefined, true);
  fs.writeFileSync(`${directory}/result.json`, text);
  return { value: JSON.parse(text) };
}

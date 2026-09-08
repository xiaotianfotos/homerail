#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SLOTS = { qwen_review: 'qwen', kimi_review: 'kimi', glm_review: 'glm' };
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SAFE_RE = /^[\x20-\x7E]{1,256}$/;

function safe(v) {
  return typeof v === 'string' && SAFE_RE.test(v) ? v : null;
}
function nonNegInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function extractDispatch(msg, runId, nodeId) {
  if (!msg || msg.role !== 'manager' || msg.type !== 'prompt') return null;
  const c = msg.content;
  if (!c || c.runId !== runId || c.nodeId !== nodeId) return null;
  const sid = safe(c.sessionId);
  if (!sid) return null;
  if (typeof msg.timestamp !== 'number' || !Number.isFinite(msg.timestamp)) return null;
  const ac = c.agentConfig;
  const llm = ac?.llm;
  return {
    session_id: sid,
    timestamp: msg.timestamp,
    binding: { provider: safe(llm?.provider), model: safe(llm?.model), backend: safe(ac?.agent_type), setting_id: safe(ac?.llm_setting_id) }
  };
}

function extractUsage(msg, runId, nodeId) {
  if (!msg || msg.role !== 'worker' || msg.type !== 'response') return null;
  const c = msg.content;
  if (!c || c.type !== 'usage') return null;
  if (c.run_id !== runId || c.node_id !== nodeId) return null;
  if (typeof msg.timestamp !== 'number' || !Number.isFinite(msg.timestamp)) return null;
  const eid = safe(c.execution_id);
  if (!eid) return null;
  const sid = safe(c.session_id);
  if (!sid) return null;
  const u = c.usage;
  if (!u || !nonNegInt(u.input_tokens) || !nonNegInt(u.output_tokens) ||
    !nonNegInt(u.cache_read_input_tokens) || !nonNegInt(u.cache_creation_input_tokens)) return null;
  const fr = safe(c.finish_reason);
  const dm = (typeof c.duration_ms === 'number' && Number.isFinite(c.duration_ms) && c.duration_ms >= 0) ? c.duration_ms : null;
  return {
    session_id: sid, timestamp: msg.timestamp, execution_id: eid,
    usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens },
    finish_reason: fr, duration_ms: dm
  };
}

export function buildPrReviewExecutionEvidence({ runId, chatsByNode }) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error('unsafe runId');
  const reviewers = [];
  const identities = new Set();

  for (const [nodeId, slot] of Object.entries(SLOTS)) {
    const chat = chatsByNode?.[nodeId];
    if (!Array.isArray(chat)) {
      reviewers.push({ slot, node_id: nodeId, availability: 'unavailable', dispatches: [], executions: [], unaccounted_dispatches: 0 });
      continue;
    }
    const rawD = [], rawU = [];
    for (const msg of chat) {
      if (!msg || typeof msg !== 'object') continue;
      const d = extractDispatch(msg, runId, nodeId);
      if (d) { rawD.push(d); continue; }
      const u = extractUsage(msg, runId, nodeId);
      if (u) rawU.push(u);
    }
    rawD.sort((a, b) => a.timestamp - b.timestamp);
    rawU.sort((a, b) => a.timestamp - b.timestamp);

    const dispatches = [];
    const seen = new Set();
    for (const d of rawD) {
      const key = JSON.stringify([d.timestamp, d.session_id, d.binding]);
      if (seen.has(key)) continue;
      seen.add(key);
      dispatches.push(d);
    }
    for (const d of dispatches) {
      if (d.binding.provider && d.binding.model) identities.add(JSON.stringify([d.binding.provider, d.binding.model]));
    }

    const execMap = new Map();
    for (const u of rawU) {
      let di = -1;
      for (let i = dispatches.length - 1; i >= 0; i--) {
        if (dispatches[i].timestamp <= u.timestamp && dispatches[i].session_id === u.session_id) { di = i; break; }
      }
      if (di === -1) continue;
      const existing = execMap.get(u.execution_id);
      if (!existing) {
        const settled = u.finish_reason !== null && u.duration_ms !== null;
        execMap.set(u.execution_id, { dispatch_index: di, session_id: u.session_id, usage: { ...u.usage }, finish_reason: u.finish_reason, duration_ms: u.duration_ms, settled });
      } else {
        if (existing.session_id !== u.session_id) continue;
        const k = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
        for (const key of k) if (u.usage[key] > existing.usage[key]) existing.usage[key] = u.usage[key];
        if (u.finish_reason !== null && existing.finish_reason === null) existing.finish_reason = u.finish_reason;
        if (u.duration_ms !== null && existing.duration_ms === null) existing.duration_ms = u.duration_ms;
        if (u.finish_reason !== null && u.duration_ms !== null) existing.settled = true;
      }
    }

    const executions = [];
    const accounted = new Set();
    for (const [id, ex] of execMap) {
      executions.push({ execution_id: id, session_id: ex.session_id, dispatch_index: ex.dispatch_index, usage_state: ex.settled ? 'final' : 'partial', usage: ex.usage, finish_reason: ex.finish_reason, duration_ms: ex.duration_ms });
      accounted.add(ex.dispatch_index);
    }
    const unaccounted = dispatches.filter((_, i) => !accounted.has(i)).length;
    reviewers.push({ slot, node_id: nodeId, availability: 'available', dispatches, executions, unaccounted_dispatches: unaccounted });
  }

  let provenance = true;
  for (const r of reviewers) {
    if (r.availability !== 'available' || r.dispatches.length === 0) { provenance = false; break; }
    for (const d of r.dispatches) {
      if (!d.binding.provider || !d.binding.model || !d.binding.backend) { provenance = false; break; }
    }
    if (!provenance) break;
  }

  let observedTokens = null, allFinal = true, anyUsage = false, allReady = true, totalUnaccounted = 0;
  for (const r of reviewers) {
    totalUnaccounted += r.unaccounted_dispatches;
    if (r.availability !== 'available' || r.dispatches.length === 0 || r.executions.length === 0) { allReady = false; continue; }
    anyUsage = true;
    for (const ex of r.executions) {
      if (ex.usage_state !== 'final') allFinal = false;
      observedTokens = (observedTokens ?? 0) + ex.usage.input_tokens + ex.usage.output_tokens + ex.usage.cache_read_input_tokens + ex.usage.cache_creation_input_tokens;
    }
  }
  let usageState;
  if (!anyUsage) { usageState = 'unknown'; observedTokens = null; }
  else if (allReady && totalUnaccounted === 0 && allFinal) usageState = 'final';
  else usageState = 'partial';

  return { schema: 'pr-review-execution-evidence-v1', run_id: runId, quorum_basis: 'reviewer_executions', distinct_model_identities: identities.size, provenance_complete: provenance, usage_state: usageState, observed_tokens: observedTokens, reviewers };
}

export async function collectPrReviewExecutionEvidence({ managerUrl, runId, outputPath }) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error('unsafe runId');
  const base = managerUrl.replace(/\/+$/, '');
  const headers = {};
  const token = process.env.HOMERAIL_DAG_MUTATION_TOKEN;
  if (token) headers['x-homerail-dag-token'] = token;
  const chatsByNode = {};
  for (const nodeId of Object.keys(SLOTS)) {
    try {
      const url = `${base}/api/dag-status/${encodeURIComponent(runId)}/node/${nodeId}/chat`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
      if (!res.ok) { chatsByNode[nodeId] = null; continue; }
      const body = await res.json();
      if (!body?.success) { chatsByNode[nodeId] = null; continue; }
      const msgs = body.data?.messages;
      chatsByNode[nodeId] = Array.isArray(msgs) ? msgs : null;
    } catch { chatsByNode[nodeId] = null; }
  }
  const evidence = buildPrReviewExecutionEvidence({ runId, chatsByNode });
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, outputPath);
  return evidence;
}

const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main) {
  const [runId, outPath] = process.argv.slice(2);
  const mgr = process.env.HOMERAIL_MANAGER_URL;
  if (!mgr || !runId || !outPath) { console.error('usage: pr-review-execution-evidence.mjs <run-id> <output.json>'); process.exit(1); }
  const e = await collectPrReviewExecutionEvidence({ managerUrl: mgr, runId, outputPath: outPath });
  console.log(JSON.stringify({ run_id: e.run_id, usage_state: e.usage_state, provenance_complete: e.provenance_complete, observed_tokens: e.observed_tokens }));
}

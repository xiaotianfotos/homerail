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

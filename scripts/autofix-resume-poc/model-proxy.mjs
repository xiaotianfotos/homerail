#!/usr/bin/env node
// Local measurement proxy. Store timings/usage only, never prompts or output text.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
const [target, host, port, log] = process.argv.slice(2);
if (!target || !host || !port || !log) throw new Error('Usage: model-proxy.mjs <origin> <listen-host> <port> <metrics.jsonl>');
http.createServer(async (req, res) => {
  if (!['/v1/chat/completions','/v1/models'].includes(req.url)) { res.writeHead(404).end(); return; }
  const abort = new AbortController(); let downstreamDisconnected = false;
  res.once('close',()=>{if(!res.writableEnded){downstreamDisconnected=true;abort.abort();}});
  const started = performance.now(); const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) { res.writeHead(413).end(); return; } chunks.push(chunk); }
  const body = Buffer.concat(chunks); let model; let reasoning;
  try { const p = JSON.parse(body.toString()); model = p.model; reasoning = p.reasoning_effort; } catch { /* GET models */ }
  const requestId = randomUUID();
  if(model) fs.appendFileSync(log, JSON.stringify({at:new Date().toISOString(),event:'request_started',request_id:requestId,model,reasoning,request_bytes:size})+'\n');
  let first = null, last = null, usage = null, status, finishReason = null; const decoder = new StringDecoder(); let pending = '';
  const observe = text => {
    pending += text; let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0,index).trim(); pending = pending.slice(index+1);
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      try {
        const event = JSON.parse(line.slice(6));
        const delta = event.choices?.[0]?.delta;
        if (delta && (delta.content || delta.reasoning_content || delta.tool_calls)) { if(first === null){first = performance.now(); fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),event:'first_token',request_id:requestId,ttft_ms:first-started})+'\n');} last = performance.now(); }
        if (event.usage) usage = event.usage;
        finishReason = event.choices?.[0]?.finish_reason ?? finishReason;
      } catch { /* Ignore non-JSON transport events. */ }
    }
  };
  try {
    const upstream = await fetch(target.replace(/\/$/,'') + req.url, { method:req.method, headers:{'content-type':'application/json', ...(req.headers.authorization ? {authorization:req.headers.authorization} : {})}, body:req.method==='GET'?undefined:body, signal:AbortSignal.any([abort.signal,AbortSignal.timeout(120000)]) });
    status = upstream.status; res.writeHead(status, {'content-type':upstream.headers.get('content-type') ?? 'application/json'});
    for await (const chunk of upstream.body) { observe(decoder.write(chunk)); res.write(chunk); }
    observe(decoder.end()); res.end();
  } catch(e) { if(!res.headersSent) res.writeHead(502); res.end(); status ??= 502; }
  finally {
    if (model) fs.appendFileSync(log, JSON.stringify({at:new Date().toISOString(),event:'request_finished',request_id:requestId,downstream_disconnected:downstreamDisconnected,usage_complete:usage!==null,model,reasoning,status,request_bytes:size,total_ms:performance.now()-started,ttft_ms:first===null?null:first-started,delivery_ms:first===null?null:last-first,usage,finish_reason:finishReason})+'\n');
  }
}).listen(Number(port), host, () => console.log(`measurement proxy listening on ${host}:${port}`));

import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function setup(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hr-proxy-test-')); const log = path.join(root,'requests.jsonl');
  const upstream = http.createServer(handler); upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
  const reservation = http.createServer(); reservation.listen(0,'127.0.0.1'); await once(reservation,'listening'); const port = reservation.address().port; await new Promise(resolve=>reservation.close(resolve));
  const child = spawn(process.execPath,[fileURLToPath(new URL('./model-proxy.mjs',import.meta.url)),`http://127.0.0.1:${upstream.address().port}`,'127.0.0.1',String(port),log],{stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill(); upstream.closeAllConnections(); await new Promise(resolve=>upstream.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('proxy exited before ready');}),pause(3000).then(()=>{throw new Error('proxy startup deadline');})]);
  return {url:`http://127.0.0.1:${port}/v1/chat/completions`,log};
}
async function finished(log) {
  for(let i=0;i<100;i++){if(fs.existsSync(log)){const rows=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);if(rows.some(r=>r.event==='request_finished'))return rows;}await pause(20);}
  throw new Error('no final measurement');
}
test('stream measurements record exact usage without prompt or response text',async t=>{
  const {url,log}=await setup(t,(_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'private-output'}}]})+'\n\n');res.end('data: '+JSON.stringify({choices:[{finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\n\ndata: [DONE]\n\n');});
  const r=await fetch(url,{method:'POST',body:JSON.stringify({model:'test',messages:[{role:'user',content:'private-prompt'}]})});await r.text();
  const rows=await finished(log),last=rows.at(-1);assert.equal(last.usage.total_tokens,15);assert.equal(last.usage_complete,true);assert.equal(last.downstream_disconnected,false);assert(last.ttft_ms>=0);
  assert(!fs.readFileSync(log,'utf8').includes('private-'));
});
test('downstream disconnect aborts upstream and marks token usage unknown',async t=>{
  let upstreamClosed=false;
  const {url,log}=await setup(t,(_req,res)=>{res.on('close',()=>{upstreamClosed=true;});res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'first'}}]})+'\n\n');});
  await new Promise((resolve,reject)=>{const req=http.request(url,{method:'POST'},res=>{res.once('data',()=>{res.destroy();resolve();});});req.on('error',reject);req.end(JSON.stringify({model:'test'}));});
  const rows=await finished(log);assert.equal(rows.at(-1).downstream_disconnected,true);assert.equal(rows.at(-1).usage_complete,false);assert.equal(rows.at(-1).usage,null);
  for(let i=0;i<50&&!upstreamClosed;i++)await pause(20);assert.equal(upstreamClosed,true);
});

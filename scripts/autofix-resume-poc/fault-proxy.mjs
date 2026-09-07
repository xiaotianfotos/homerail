#!/usr/bin/env node
// Explicit lab-only transport fault: execute one submission, drop its response.
import http from 'node:http';
import fs from 'node:fs';
const [target, host, port, flag, log] = process.argv.slice(2);
http.createServer(async (req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  try{
    if(req.url==='/api/runs/create-and-run' && fs.existsSync(flag+'.before')){
      fs.unlinkSync(flag+'.before');fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),fault:'submission_not_forwarded'})+'\n');res.destroy();return;
    }
    const r=await fetch(target+req.url,{method:req.method,headers:{'content-type':'application/json','x-homerail-dag-token':req.headers['x-homerail-dag-token']??''},body:req.method==='GET'?undefined:Buffer.concat(chunks)});
    const text=await r.text();
    if(req.url==='/api/runs/create-and-run' && r.ok && fs.existsSync(flag)){
      fs.unlinkSync(flag);const v=JSON.parse(text);fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),fault:'submission_response_dropped',run_id:v.data?.run_id})+'\n');res.destroy();return;
    }
    res.writeHead(r.status,{'content-type':r.headers.get('content-type')??'application/json'});res.end(text);
  }catch(e){if(!res.headersSent)res.writeHead(502);res.end();}
}).listen(Number(port),host,()=>console.log('fault proxy ready'));

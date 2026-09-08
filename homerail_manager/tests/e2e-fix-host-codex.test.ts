import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHostCodexStructuredTurn } from "../src/server/host-codex-manager-agent.js";
import { parseE2eFixWorkflow, E2E_FIX_STAGES, type E2eFixStage } from "../src/orchestration/e2e-fix-workflow.js";
import { frozenE2eFixHostCodexCommands } from "../src/runtime/e2e-fix-runtime.js";
import { e2eFixHostCodexSchema, normalizeE2eFixHostCodexOutput } from "../src/runtime/e2e-fix-host-codex.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const schema = { type: "object", additionalProperties: false, required: ["strategy"], properties: { strategy: { type: "string" } } };
function fixture(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-codex-role-")); roots.push(root);
  const binary = path.join(root, "codex.mjs");
  fs.writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs'; import {createInterface} from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
const out = value => process.stdout.write(JSON.stringify(value)+'\\n');
const mode = ${JSON.stringify(mode)};
fs.writeFileSync(${JSON.stringify(path.join(root, "pid"))},String(process.pid));
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line); if (!q.method) return;
 fs.appendFileSync(${JSON.stringify(path.join(root, "requests.jsonl"))}, JSON.stringify(q)+'\\n');
 const reply=result=>out({id:q.id,result}); const event=(method,params)=>out({method,params});
 if(q.method==='initialize') reply({});
 else if(q.method==='account/read') reply({account:{type:mode==='wrong-auth'?'apiKey':'chatgpt'}});
 else if(q.method==='config/read') reply({config:{mcp_servers:{danger:{command:'private-command'}}}});
 else if(q.method==='thread/start') reply({thread:{id:'thread-1'}});
 else if(q.method==='turn/start') {
  if(mode==='strict-judge'||mode==='strict-patch'){
   const valid=s=>!s||typeof s!=='object'||((!s.properties||(s.additionalProperties===false&&Object.keys(s.properties).every(k=>s.required?.includes(k))))&&Object.values(s.properties??{}).every(valid)&&(!s.items||valid(s.items))&&(!s.anyOf||s.anyOf.every(valid)));
   if(!valid(q.params.outputSchema)){out({id:q.id,error:{message:'invalid_json_schema: all properties must be required'}});return;}
  }
  reply({turn:{id:'turn-1'}}); if(mode==='timeout') return;
  if(mode==='provider-error'){event('error',{message:'invalid_json_schema: missing retry_strategy',willRetry:false});return;}
  if(mode==='tool') event('item/started',{item:{type:'commandExecution',id:'bad',command:'forbidden'}});
  event('item/completed',{item:{type:'agentMessage',id:'result',phase:'final_answer',text:mode==='invalid'?'{}':JSON.stringify(mode==='strict-patch'?{summary:'bounded patch',edits:[{path:'sum.cjs',old:'a-b',new:'a+b'}]}:mode==='strict-judge'?{verdict:'pause',reason:'unknown execution',retry_strategy:null,dispositions:[]}:{strategy:'minimal change'})}});
  event('thread/tokenUsage/updated',{threadId:'thread-1',turnId:'turn-1',tokenUsage:{total:{inputTokens:100,outputTokens:5}}});
  event('turn/completed',{turn:{id:mode==='wrong-turn'?'turn-other':'turn-1',status:mode==='failed'?'failed':'completed'}});
 } else reply({});
});
`, { mode: 0o700 });
  return { root, binary };
}

describe.skipIf(process.platform === "win32")("fresh structured host Codex transport", () => {
  it("constrains inherited tools and records authentic completion/usage", async () => {
    const { root, binary } = fixture("ok"); const evidence: Record<string, unknown>[] = [];
    const value = await runHostCodexStructuredTurn({ model: "fixture-model", workspace: root, prompt: "issue evidence", instructions: "bounded plan",
      schema, timeoutMs: 5000, outputBytes: 4000, codexBin: binary, evidence: e => evidence.push(e) });
    expect(value).toEqual({ strategy: "minimal change" });
    const requests = fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(q => q.method === "turn/start")).toHaveLength(1);
    expect(requests.find(q => q.method === "thread/start").params).toMatchObject({ ephemeral: true, sandbox: "read-only", dynamicTools: [],
      config: { mcp_servers: { danger: { enabled: false } }, web_search: "disabled" } });
    expect(requests.find(q => q.method === "thread/start").params).not.toHaveProperty("tools");
    expect(requests.find(q => q.method === "turn/start").params.outputSchema).toEqual(schema);
    expect(evidence.map(e => e.event)).toEqual(["thread_created", "turn_started", "token_usage", "turn_result"]);
  });
  it.each(["failed", "wrong-turn", "invalid", "tool", "timeout", "wrong-auth", "provider-error"])("rejects %s without returning model approval or leaking its process", async mode => {
    const { root, binary } = fixture(mode);
    await expect(runHostCodexStructuredTurn({ model: "fixture-model", workspace: root, prompt: "issue", instructions: "plan",
      schema, timeoutMs: mode === "timeout" ? 300 : 5000, outputBytes: 4000, codexBin: binary, evidence: () => {} })).rejects.toThrow();
    const pid = Number(fs.readFileSync(path.join(root, "pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000, interval: 20 });
  });
  it.each(["judge_candidate", "judge_ci"] as const)("uses a strict provider schema and nullable strategy for %s", async role => {
    const { root, binary } = fixture("strict-judge");
    const value = await runHostCodexStructuredTurn({ model: "fixture-model", workspace: root, prompt: "failure evidence", instructions: "judge",
      schema: e2eFixHostCodexSchema(role), timeoutMs: 5000, outputBytes: 4000, codexBin: binary, evidence: () => {} });
    expect(value).toMatchObject({ retry_strategy: null });
    expect(normalizeE2eFixHostCodexOutput(role, value)).toEqual({ verdict: "pause", reason: "unknown execution", dispositions: [] });
    const revision = { verdict: "revise", reason: "truncated", retry_strategy: "Use smaller replacements", dispositions: [] };
    expect(normalizeE2eFixHostCodexOutput(role, revision)).toEqual(revision);
  });
  it("returns a strict patch through a fresh restricted host session", async () => {
    const { root, binary } = fixture("strict-patch");
    const value = await runHostCodexStructuredTurn({ model: "fixture-model", workspace: root, prompt: "frozen plan and sources", instructions: "bounded fixer",
      schema: e2eFixHostCodexSchema("fix"), timeoutMs: 5000, outputBytes: 4000, codexBin: binary, evidence: () => {} });
    expect(value).toEqual({ summary: "bounded patch", edits: [{ path: "sum.cjs", old: "a-b", new: "a+b" }] });
    expect(normalizeE2eFixHostCodexOutput("fix", value)).toEqual(value);
    const requests = fs.readFileSync(path.join(root, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.find(q => q.method === "thread/start").params).toMatchObject({ ephemeral: true, sandbox: "read-only", dynamicTools: [] });
    expect(requests.filter(q => q.method === "turn/start")).toHaveLength(1);
  });
});

it("keeps host Codex roles inside the native DAG with durable failure routes", () => {
  const commands = frozenE2eFixHostCodexCommands({ directory: "/frozen", sha256: "a".repeat(64), node: "/frozen/node", bootstrap: "/frozen/bootstrap.mjs" }, "/task");
  const stageCommands = Object.fromEntries(E2E_FIX_STAGES.map(stage => [stage, ["node", "/stage", stage]])) as Record<E2eFixStage, string[]>;
  const parsed = parseE2eFixWorkflow({ workflowId: "host-roles", maxRounds: 3, stageCommands, hostCodexCommands: commands });
  for (const role of ["plan", "judge_candidate", "judge_ci"]) {
    expect(parsed.graph.nodes.find(n => n.node_id === role)).toMatchObject({ node_type: "command_gateway", gateway_config: { durable: true } });
    expect(parsed.graph.edges.some(e => e.from_node === role && e.from_port === "failed" && e.terminal_outcome === "failure")).toBe(true);
  }
  expect(parsed.graph.nodes.find(n => n.node_id === "fix")?.node_type).toBe("agent");
});

it("uses an opted-in durable Fixer with a single failure route and independent Worker reviewers", () => {
  const commands = frozenE2eFixHostCodexCommands({ directory: "/frozen", sha256: "a".repeat(64), node: "/frozen/node", bootstrap: "/frozen/bootstrap.mjs" }, "/task", { fixer: true });
  expect(commands.fix?.slice(-4)).toEqual(["a".repeat(64), "/task", "host-codex", "fix"]);
  const stageCommands = Object.fromEntries(E2E_FIX_STAGES.map(stage => [stage, ["node", "/stage", stage]])) as Record<E2eFixStage, string[]>;
  const parsed = parseE2eFixWorkflow({ workflowId: "host-fixer", maxRounds: 3, stageCommands, hostCodexCommands: commands });
  expect(parsed.graph.nodes.find(n => n.node_id === "fix")).toMatchObject({ node_type: "command_gateway", gateway_config: { durable: true } });
  const failures = parsed.graph.edges.filter(e => e.from_node === "fix" && e.from_port === "failed");
  expect(failures).toHaveLength(1); expect(failures[0].terminal_outcome).toBe("failure");
  for (const id of ["review_a", "review_b", "review_c"]) expect(parsed.graph.nodes.find(n => n.node_id === id)?.node_type).toBe("agent");
});

it.each(["plan", "fix"])("authenticates %s receipts against command/session, output and event bytes", async role => {
  const { prepareDurableCommand } = await import("../src/runtime/durable-command.js");
  const { closeDb } = await import("../src/persistence/db.js");
  const { readE2eFixHostCodexEvidence } = await import("../src/runtime/e2e-fix-host-codex.js");
  const { e2eFixDigest } = await import("../src/runtime/e2e-fix-candidates.js");
  if (process.platform !== "linux") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-codex-receipt-")); roots.push(root);
  const before = process.env.HOMERAIL_HOME; process.env.HOMERAIL_HOME = path.join(root, "home"); closeDb();
  try {
    const identity = { run_id: "root", node_id: role, session_id: "session", round_id: "round", attempt: 1 };
    const command = prepareDurableCommand(identity, { argv: [process.execPath, "role"], cwd: root, stdin: "{}", timeout_ms: 1000, capture_limit: 2000 });
    const folder = path.join(root, "rounds", "1", "host-codex", role); fs.mkdirSync(folder, { recursive: true });
    const runtime = "a".repeat(64); const model = "fixture-model";
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ runtime_sha256: runtime, host_codex: { model, fixer: role === "fix" } }));
    const events = [{ event: "thread_created", thread_id: "native", persistent: false }, { event: "turn_started", turn_id: "turn" },
      { event: "turn_result", turn_id: "turn", status: "completed" }].map(e => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(path.join(folder, "events.jsonl"), events);
    const value = role === "fix" ? { summary: "minimal", edits: [{ path: "sum.cjs", old: "a-b", new: "a+b" }] } : { strategy: "minimal" };
    fs.writeFileSync(path.join(folder, "receipt.json"), JSON.stringify({ version: 1, command_id: command.execution_id, identity, round: 1, runtime_sha256: runtime, model,
      input_sha256: e2eFixDigest(JSON.stringify("{}")), output_sha256: e2eFixDigest(JSON.stringify(value)), events_sha256: e2eFixDigest(events), value }));
    expect(readE2eFixHostCodexEvidence(root, role, 1, identity)).toMatchObject({ value, native_thread_id: "native", usages: [] });
    expect(() => readE2eFixHostCodexEvidence(root, role, 1, { ...identity, session_id: "other" })).toThrow(/provenance/);
    if (role === "fix") {
      fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ runtime_sha256: runtime, host_codex: { model } }));
      expect(() => readE2eFixHostCodexEvidence(root, role, 1, identity)).toThrow(/provenance/);
      fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ runtime_sha256: runtime, host_codex: { model, fixer: true } }));
    }
    fs.appendFileSync(path.join(folder, "events.jsonl"), " ");
    expect(() => readE2eFixHostCodexEvidence(root, role, 1, identity)).toThrow(/provenance/);
  } finally { closeDb(); if (before === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = before; }
});

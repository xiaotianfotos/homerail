import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerAdapter } from "../agent/codex-appserver.js";
import { runPrompt, type PromptJob } from "../prompt-runner.js";
import type { AgentEvent, AgentRunContext, DagToolDefinition } from "../agent/types.js";

const roots: string[] = [];

// Test-only spawn launch boundary. Windows cannot exec an extensionless POSIX
// shebang script, so only the current fixture binary is re-expressed as a real
// Node child running the identical fixture source. Every other command, and
// spawnSync, keep the actual implementation, and stdio JSON-RPC stays genuine.
const launcher = vi.hoisted(() => ({ fixture: null as { bin: string; script: string } | null, frames: [] as Array<Record<string, unknown>> }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const forward = actual.spawn as unknown as (...call: unknown[]) => unknown;
  const spawn = ((command: unknown, ...rest: unknown[]) => {
    const [args, ...tail] = rest;
    const launch = launcher.fixture;
    const isFixture = launch && String(command) === launch.bin;
    // Only Windows needs an explicit interpreter; Linux keeps real exec/shebang.
    const child = (isFixture && process.platform === "win32"
      ? forward(process.execPath, [launch.script, ...(Array.isArray(args) ? args as string[] : [])], ...tail)
      : forward(command, ...rest)) as ReturnType<typeof actual.spawn>;
    if (isFixture && child.stdin) {
      const write = child.stdin.write.bind(child.stdin);
      // Capture complete JSON-RPC writes on the parent side before shutdown can
      // terminate the child. This asserts the attempted wire response, not a
      // guarantee that a terminated child consumed it or flushed its log.
      child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        for (const line of (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")).trim().split("\n")) {
          if (line) launcher.frames.push(JSON.parse(line));
        }
        return (write as (...args: unknown[]) => boolean)(chunk, ...args);
      }) as typeof child.stdin.write;
    }
    return child;
  }) as unknown as typeof actual.spawn;
  return { ...actual, spawn };
});

function fixture(options: { toolOnResume?: string; account?: string; model?: string; status?: string; slowAck?: boolean; silent?: boolean; resumeError?: boolean; toolCall?: boolean; permissionMismatch?: boolean; networkAccess?: boolean } = {}) {
  // Windows runner temp roots arrive as 8.3 short names that the adapter resolves.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-codex-adapter-test-")));
  roots.push(root);
  const home = path.join(root, "native-home");
  const state = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  for (const dir of [home, state, workspace]) fs.mkdirSync(dir);
  const log = path.join(root, "requests.jsonl");
  const pidFile = path.join(root, "process.pid");
  const bin = path.join(root, "codex");
  // A real process and JSON-RPC transport: no model calls and no global host configuration.
  const script = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const options = ${JSON.stringify(options)};
const log = ${JSON.stringify(log)};
let resumed = false;
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const reply = (id, result) => process.stdout.write(JSON.stringify({id,result})+'\\n');
const notify = (method, params) => process.stdout.write(JSON.stringify({method,params})+'\\n');
const thread = (request) => ({thread:{id:'native-thread'},model:options.model||'exact-model',modelProvider:'openai',reasoningEffort:'low',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:options.networkAccess||false},activePermissionProfile:{id:options.permissionMismatch?'unrestricted-user-profile':request.params.permissions}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(req)+'\\n');
 if(req.id===500 && req.result && options.toolOnResume)notify('turn/completed',{threadId:'native-thread',turn:{id:'native-turn',status:'completed'}});
 switch(req.method){
 case 'initialize':reply(req.id,{});break;
 case 'account/read':reply(req.id,{account:{type:options.account||'chatgpt'}});break;
 case 'model/list':reply(req.id,{data:[{model:'exact-model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]});break;
 case 'config/read':reply(req.id,{config:{mcp_servers:{ambient:{command:'never-run'}}}});break;
 case 'skills/list':reply(req.id,{data:[{skills:[{path:'/ambient/skill/SKILL.md'}]}]});break;
 case 'thread/start':reply(req.id,thread(req));break;
 case 'thread/resume':
   resumed=true;
   if(options.resumeError)process.stdout.write(JSON.stringify({id:req.id,error:{code:-1,message:'missing transcript'}})+'\\n');
   else reply(req.id,thread(req));break;
 case 'turn/start':
   setTimeout(()=>{
     reply(req.id,{turn:{id:'native-turn'}});
     if(options.toolCall || (resumed && options.toolOnResume)){
       process.stdout.write(JSON.stringify({id:500,method:'item/tool/call',params:{threadId:'native-thread',turnId:'native-turn',callId:'native-handoff',tool:options.toolOnResume||'handoff',arguments:{port:'done',content:'complete'}}})+'\\n');
     }else if(!options.slowAck && !options.silent){
       notify('item/completed',{threadId:'native-thread',turnId:'native-turn',item:{type:'agentMessage',phase:'final_answer',text:'verified result'}});
       notify('turn/completed',{threadId:'native-thread',turn:{id:'native-turn',status:options.status||'completed'}});
     }
   },options.slowAck?150:0);break;
 case 'turn/interrupt':reply(req.id,{});if(!options.silent)notify('turn/completed',{threadId:'native-thread',turn:{id:'native-turn',status:'interrupted'}});break;
 case 'thread/unsubscribe':reply(req.id,{});break;
 }
});
`;
  fs.writeFileSync(bin, script, { mode: 0o700 });
  launcher.fixture = { bin, script: bin };
  launcher.frames.length = 0;
  if (process.platform === "win32") {
    // Windows has no shebang execution: the launch boundary above runs this exact
    // fixture source as a real Node child, so transport and PID identity hold.
    const scriptFile = path.join(root, "native-codex-fixture.cjs");
    fs.writeFileSync(scriptFile, script.replace(/^#![^\n]*\n/, ""), { mode: 0o700 });
    launcher.fixture = { bin, script: scriptFile };
  }
  vi.stubEnv("HOMERAIL_CODEX_SUBSCRIPTION_ENABLED", "1");
  vi.stubEnv("HOMERAIL_CODEX_SUBSCRIPTION_HOME", home);
  vi.stubEnv("HOMERAIL_CODEX_SUBSCRIPTION_STATE_DIR", state);
  vi.stubEnv("HOMERAIL_CODEX_SUBSCRIPTION_BIN", bin);
  const context: AgentRunContext = {
    protocol: "codex_subscription", provider: "openai", model: "exact-model", reasoningEffort: "low",
    apiKey: "", baseUrl: "", workspace, sessionId: "stable-run/node", codexSandbox: "read-only",
    workspaceAccess: { writable_paths: [], readonly_paths: ["."] },
  };
  const requests = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { context, requests, state, home, pidFile };
}

async function collect(context: AgentRunContext, tools: DagToolDefinition[] = []): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of new CodexAppServerAdapter().run("Read only", tools, context)) events.push(event);
  return events;
}

afterEach(() => {
  launcher.fixture = null;
  launcher.frames.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("native Codex subscription transport", () => {
  it("refuses to replace a required but missing native history binding", async () => {
    const f = fixture();
    expect(await collect({ ...f.context, resumeSession: true })).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("history binding is missing") }));
    expect(f.requests().some(c => c.method === "thread/start" || c.method === "turn/start")).toBe(false);
    expect(fs.readdirSync(f.state)).toHaveLength(0);
  });
  it("persists the native ID before turn ACK, resumes it across processes, and keeps restricted policy", async () => {
    const f = fixture();
    const first = await collect(f.context);
    expect(first.some(e => e.type === "error")).toBe(false);
    expect(first).toContainEqual({ type: "text", text: "verified result" });
    expect(fs.readdirSync(f.state)).toHaveLength(1);
    const second = await collect(f.context);
    expect(second.some(e => e.type === "error")).toBe(false);
    expect(second).toContainEqual(expect.objectContaining({ type: "debug", message: "thread_resumed" }));
    const calls = f.requests();
    expect(calls.filter(c => c.method === "thread/start")).toHaveLength(1);
    expect(calls.filter(c => c.method === "thread/resume")).toHaveLength(1);
    const start = calls.find(c => c.method === "thread/start").params;
    expect(start).toMatchObject({ ephemeral: false, model: "exact-model", modelProvider: "openai", approvalPolicy: "never", allowProviderModelFallback: false });
    expect(start).not.toHaveProperty("sandbox");
    expect(start.config.mcp_servers.ambient.enabled).toBe(false);
    expect(start.config.skills.config).toEqual([{ path: "/ambient/skill/SKILL.md", enabled: false }]);
    const turn = calls.find(c => c.method === "turn/start").params;
    expect(turn.permissions).toBe(start.permissions);
    expect(typeof start.permissions).toBe("string");
    expect(turn).not.toHaveProperty("sandboxPolicy");
    const profile = start.config.permissions[start.permissions];
    expect(profile.network.enabled).toBe(false);
    expect(profile.filesystem).toMatchObject({
      ":root": "deny", ":minimal": "read", [f.context.workspace!]: "read", [f.home]: "deny", [f.state]: "deny",
    });
  });

  it.each(["handoff", "report_activity"])("resumes a missing-handoff correction and enforces its tool allowlist (%s)", async toolOnResume => {
    const f = fixture({ toolOnResume });
    const executed: string[] = [];
    const run = CodexAppServerAdapter.prototype.run;
    vi.spyOn(CodexAppServerAdapter.prototype, "run").mockImplementation(function (this: CodexAppServerAdapter, prompt, tools, context) {
      return run.call(this, prompt, tools.map(tool => ({
        ...tool,
        handler: (args, callContext) => {
          executed.push(tool.name);
          return tool.handler(args, callContext);
        },
      })), context);
    });
    vi.stubEnv("WORKSPACE", f.context.workspace!);
    const job: PromptJob = {
      task: "Inspect and hand off", sender: "test", runId: "native-correction-run",
      nativeSessionRequired: false, llmProvider: "openai", llmProtocol: "codex_subscription",
      dagConfig: {
        node_id: "reader", agent_type: "codex_appserver", model: "exact-model", reasoning_effort: "low",
        codex_sandbox: "read-only", builtin_tool_policy: "backend_native",
        workspace_access: { writable_paths: [], readonly_paths: ["."] },
        incoming_edges: [], outgoing_edges: [{ from_port: "done", to_node: "result", to_port: "in" }],
        graph_nodes: ["reader", "result"], allowed_dag_tools: ["handoff", "report_activity"],
      },
    };
    const messages: Array<Record<string, any>> = [];
    const deps = { agentBackend: "codex_appserver", wsSend: (raw: string) => { messages.push(JSON.parse(raw)); } };
    const first = await runPrompt(job, deps);
    expect(first.status).toBe("failed");
    expect(messages.some(m => m.type === "node_error" && /handoff/i.test(m.data.message))).toBe(true);
    const saved = fs.readFileSync(path.join(f.state, fs.readdirSync(f.state)[0]), "utf8");
    messages.length = 0;
    const correction = await runPrompt({ ...job, nativeSessionRequired: true, task: "## input:correction\nSubmit the missing handoff" }, deps);
    const calls = f.requests();
    expect(calls.filter(c => c.method === "thread/start")).toHaveLength(1);
    expect(calls.filter(c => c.method === "thread/resume")).toHaveLength(1);
    expect(calls.find(c => c.method === "thread/resume").params.threadId).toBe("native-thread");
    expect(calls.filter(c => c.method === "turn/start")).toHaveLength(2);
    expect(calls.find(c => c.method === "thread/start").params.dynamicTools.map((t: {name: string}) => t.name).sort()).toEqual(["handoff", "report_activity"]);
    expect(fs.readFileSync(path.join(f.state, fs.readdirSync(f.state)[0]), "utf8")).toBe(saved);
    if (toolOnResume === "handoff") {
      expect(correction.status).toBe("completed");
      expect(executed).toEqual(["handoff"]);
      expect(messages.filter(m => m.type === "response")).toHaveLength(1);
      expect(calls).toContainEqual(expect.objectContaining({ id: 500, result: expect.objectContaining({ success: true }) }));
    } else {
      expect(correction).toMatchObject({ status: "failed", reason: expect.stringContaining("outside the HomeRail allowlist") });
      expect(messages.some(m => m.type === "response")).toBe(false);
      // Rejection shuts down the child; it need not flush a best-effort RPC
      // error into the fixture log before exit. Assert the permission boundary.
      expect(executed).toEqual([]);
      expect(launcher.frames).toContainEqual(expect.objectContaining({ id: 500, error: expect.objectContaining({ message: expect.stringContaining("allowlist") }) }));
    }
  });

  it("rejects turn tools outside the declared schema and changed session declarations before resume", async () => {
    const f = fixture();
    const handoff: DagToolDefinition = { name: "handoff", description: "Return", input_schema: { type: "object" }, handler: vi.fn() };
    expect(await collect({ ...f.context, nativeSessionTools: [] }, [handoff])).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("stable session declarations") }));
    expect(f.requests().some(c => c.method === "thread/start")).toBe(false);
    await collect({ ...f.context, nativeSessionTools: [handoff] }, [handoff]);
    const changed = { ...handoff, input_schema: { type: "object", properties: { changed: { type: "string" } } } };
    expect(await collect({ ...f.context, nativeSessionTools: [handoff] }, [changed])).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("stable session declarations") }));
    expect(await collect({ ...f.context, nativeSessionTools: [changed] }, [changed])).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("binding changed") }));
    expect(f.requests().some(c => c.method === "thread/resume")).toBe(false);
    expect(f.requests().filter(c => c.method === "turn/start")).toHaveLength(1);
  });

  it.each(["apiKey", "amazonBedrock"])("refuses %s authentication before thread creation", async account => {
    const f = fixture({ account });
    const events = await collect(f.context);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("existing ChatGPT login") }));
    expect(f.requests().some(c => c.method === "thread/start" || c.method === "turn/start")).toBe(false);
  });

  it("rejects unavailable model and reasoning without starting a thread", async () => {
    const f = fixture();
    expect(await collect({ ...f.context, reasoningEffort: "ultra" })).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("fallback is disabled") }));
    expect(f.requests().some(c => c.method === "thread/start")).toBe(false);
  });

  it("rejects a server model substitution before any billable turn", async () => {
    const f = fixture({ model: "different-model" });
    expect(await collect(f.context)).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("did not honor") }));
    expect(f.requests().some(c => c.method === "turn/start")).toBe(false);
  });

  it.each([{ permissionMismatch: true }, { networkAccess: true }])("rejects a server permission substitution before any turn %j", async option => {
    const f = fixture(option);
    expect(await collect(f.context)).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("did not honor") }));
    expect(f.requests().some(c => c.method === "turn/start")).toBe(false);
    expect(fs.readdirSync(f.state)).toHaveLength(0);
  });

  it.each(["failed", "interrupted"])("maps terminal %s to an error instead of successful completion", async status => {
    const f = fixture({ status });
    const events = await collect(f.context);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining(status) }));
    expect(events.some(e => e.type === "turn_complete")).toBe(false);
  });

  it("cancels after a delayed turn ACK and retains the native session association", async () => {
    const f = fixture({ slowAck: true });
    const controller = new AbortController();
    const result = collect({ ...f.context, abortSignal: controller.signal });
    await vi.waitFor(() => expect(f.requests().some(c => c.method === "turn/start")).toBe(true));
    expect(fs.readdirSync(f.state).some(file => file.endsWith(".json"))).toBe(true);
    controller.abort();
    const events = await result;
    expect(f.requests()).toContainEqual(expect.objectContaining({ method: "turn/interrupt", params: { threadId: "native-thread", turnId: "native-turn" } }));
    expect(events.some(e => e.type === "error")).toBe(true);
    expect(fs.readdirSync(f.state)).toHaveLength(1);
  });

  it("rejects native cancellation without a terminal acknowledgement", async () => {
    const f = fixture({ silent: true });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of new CodexAppServerAdapter(undefined, 20).run("Read only", [], { ...f.context, abortSignal: controller.signal })) {
      events.push(event);
      if (event.type === "debug" && event.message === "turn_started") controller.abort();
    }
    expect(f.requests()).toContainEqual(expect.objectContaining({ method: "turn/interrupt", params: { threadId: "native-thread", turnId: "native-turn" } }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("cancelled before terminal acknowledgement") }));
    expect(events.some(event => event.type === "turn_complete")).toBe(false);
    expect(fs.readdirSync(f.state)).toHaveLength(1);
  });

  it("never creates a replacement transcript after resume failure", async () => {
    const f = fixture({ resumeError: true });
    await collect(f.context);
    expect(await collect(f.context)).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("missing transcript") }));
    expect(f.requests().filter(c => c.method === "thread/start")).toHaveLength(1);
    expect(f.requests().filter(c => c.method === "turn/start")).toHaveLength(1);
  });

  it("acknowledges a handoff and releases the process and lease when its consumer stops at the tool result", async () => {
    const f = fixture({ toolCall: true });
    const authFile = path.join(f.home, "auth.json");
    fs.writeFileSync(authFile, '{"testOnly":"preserve-native-account"}');
    let sawResult = false;
    try {
      for await (const event of new CodexAppServerAdapter().run("Read only", [{
        name: "handoff",
        description: "Return the result",
        input_schema: { type: "object" },
        handler: async () => ({ content: [{ type: "text", text: "accepted" }] }),
      }], f.context)) {
        if (event.type !== "tool_result") continue;
        sawResult = true;
        // The consumer has not requested another generator event: the RPC ACK
        // must already be on the pipe before exposing the handoff result.
        await vi.waitFor(() => expect(f.requests()).toContainEqual({
          jsonrpc: "2.0", id: 500,
          result: { contentItems: [{ type: "inputText", text: "accepted" }], success: true },
        }));
        break;
      }
      expect(sawResult).toBe(true);
      expect(fs.readdirSync(f.state)).toHaveLength(1);
      expect(fs.readdirSync(f.state)[0]).toMatch(/\.json$/);
      const pid = Number(fs.readFileSync(f.pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      const start = f.requests().find(c => c.method === "thread/start").params;
      const filesystem = start.config.permissions[start.permissions].filesystem;
      const scratch = Object.keys(filesystem).find(p => path.isAbsolute(p) && filesystem[p] === "read" && p !== f.context.workspace)!;
      expect(fs.existsSync(scratch)).toBe(false);
      expect(fs.readFileSync(authFile, "utf8")).toBe('{"testOnly":"preserve-native-account"}');
    } finally {
      // A regression must not leave a fixture process behind.
      if (fs.existsSync(f.pidFile)) {
        try { process.kill(Number(fs.readFileSync(f.pidFile, "utf8")), "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  });
});

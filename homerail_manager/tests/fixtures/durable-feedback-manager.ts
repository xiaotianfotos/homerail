// Real process recovery around a second native feedback iteration. There are
// no model/GitHub calls; only the normal startup hook can resume scheduling.
import fs from "node:fs";
import path from "node:path";
import { GraphExecutor } from "../../src/orchestration/graph-executor.js";
import { FakeDAGDispatcher } from "../../src/orchestration/dag-dispatcher.js";
import { parseWorkflowSource } from "../../src/orchestration/workflow-spec-v1.js";
import { recoverAllActiveRuns, resumeRecoveredDurableCommandGateways, getActiveRun } from "../../src/runtime/active-runs.js";
import { subscribe } from "../../src/events/bus.js";
import { loadRunSnapshot } from "../../src/persistence/store.js";

const [root, mode] = process.argv.slice(2);
process.env.HOMERAIL_HOME = root;
process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = process.execPath.toLowerCase();
const dispatcher = new FakeDAGDispatcher();
const executor = new GraphExecutor(dispatcher);
const workspace = path.join(root, "workspace", "root");
const record = () => ({ pid: process.pid, session: getActiveRun("root")?.nodeSessions.get("work"),
  snapshot: loadRunSnapshot("root"), count: fs.existsSync(path.join(workspace, "count")) ? fs.readFileSync(path.join(workspace, "count"), "utf8") : "" });
const timer = setInterval(() => {
  if (mode === "start" && record().count === "xx" && !fs.existsSync(path.join(root, "start-manager.json"))) {
    fs.writeFileSync(path.join(root, "start-manager.json"), JSON.stringify(record()));
  }
}, 20);
subscribe("dag:run_completed", () => {
  fs.writeFileSync(path.join(root, "recovered-proof.json"), JSON.stringify(record()));
  clearInterval(timer);
});
if (mode === "start") {
  const code = `const fs=require('fs');fs.appendFileSync('count','x');
    if(fs.readFileSync('count','utf8')==='x')console.log(JSON.stringify({status:'again'}));
    else {const timer=setInterval(()=>{if(fs.existsSync('release')){clearInterval(timer);console.log(JSON.stringify({status:'complete'}));}},20);}`;
  const workflow = { api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: "feedback-restart", name: "feedback restart" }, spec: {
    agents: {}, contracts: { State: { type: "object", required: ["status"], properties: { status: { type: "string" } } } }, nodes: {
      cycle: { kind: "while", inputs: { state: { contract: "State" } }, outputs: { next: {}, done: {}, exhausted: {} },
        config: { field: "status", operator: "eq", value: "complete", continue_port: "next", done_port: "done", exhausted_port: "exhausted", max_iterations: 3 } },
      work: { kind: "command", inputs: { state: {} }, outputs: { ready: {}, failed: {} },
        config: { command: [process.execPath, "-e", code], cwd: "$run_workspace", durable: true, timeout_ms: 20000,
          success_port: "ready", failure_port: "failed", parse_stdout: "json", result_payload: "value" } },
      done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
      failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
      exhausted: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
    }, edges: [{ from: "$run.input", to: "cycle.state" }, { from: "cycle.next", to: "work.state" },
      { kind: "feedback", from: "work.ready", to: "cycle.state", max_traversals: 3 },
      { from: "cycle.done", to: "done.result" }, { from: "cycle.exhausted", to: "exhausted.result" },
      { from: "work.failed", to: "failed.result", condition: "on_failure" }] } };
  executor.createRun("root", parseWorkflowSource(JSON.stringify(workflow)), JSON.stringify({ status: "again" }));
  executor.tick("root");
} else {
  const recovery = recoverAllActiveRuns();
  if (!recovery.recovered.includes("root")) throw new Error(JSON.stringify(recovery));
  // Capture the restored second-session identity before an already finished
  // command can advance the graph through the normal startup hook.
  fs.writeFileSync(path.join(root, "recover-manager.json"), JSON.stringify(record()));
  resumeRecoveredDurableCommandGateways(dispatcher);
}

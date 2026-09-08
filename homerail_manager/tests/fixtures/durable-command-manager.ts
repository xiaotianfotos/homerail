// A separate Manager runtime process for the SIGKILL recovery test. The test
// parent may kill/restart this process and release the test, but never handoff.
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
const keepAlive = setInterval(() => {}, 1000);
subscribe("dag:run_completed", () => {
  fs.writeFileSync(path.join(root, "recovered-proof.json"), JSON.stringify({
    manager_pid: process.pid, status: getActiveRun("root")?.status, snapshot: loadRunSnapshot("root"),
    count: fs.readFileSync(path.join(root, "workspace", "root", "count"), "utf8"),
  }));
  clearInterval(keepAlive);
});
if (mode === "start") {
  const code = `const fs=require('fs');fs.appendFileSync('count','x');const timer=setInterval(()=>{
    if(fs.existsSync('release')){clearInterval(timer);console.log(JSON.stringify({executed:true}));}
  },20);`;
  const workflow = { api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: "restart-test", name: "restart test" }, spec: {
    agents: {}, contracts: { Task: { type: "string" } }, nodes: {
      test: { kind: "command", inputs: { task: { contract: "Task" } }, outputs: { ready: {}, failed: {} },
        config: { command: [process.execPath, "-e", code], cwd: "$run_workspace", durable: true, timeout_ms: 15000,
          success_port: "ready", failure_port: "failed", parse_stdout: "json", result_payload: "value" } },
      done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
      failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
    }, edges: [{ from: "$run.input", to: "test.task" }, { from: "test.ready", to: "done.result" },
      { from: "test.failed", to: "failed.result", condition: "on_failure" }] } };
  executor.createRun("root", parseWorkflowSource(JSON.stringify(workflow)), JSON.stringify("run real test"));
  executor.tick("root");
} else {
  const recovery = recoverAllActiveRuns();
  if (!recovery.recovered.includes("root")) throw new Error(JSON.stringify(recovery));
  resumeRecoveredDurableCommandGateways(dispatcher);
}
fs.writeFileSync(path.join(root, `${mode}-manager.json`), JSON.stringify({ pid: process.pid, session: getActiveRun("root")?.nodeSessions.get("test") }));

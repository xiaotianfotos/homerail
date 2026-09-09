// Separate Manager lifecycle around the actual CI provider observer. GitHub is
// injected by e2e-ci-observer; the test parent never hands off a stage result.
import fs from "node:fs";
import path from "node:path";
import { GraphExecutor } from "../../src/orchestration/graph-executor.js";
import { FakeDAGDispatcher } from "../../src/orchestration/dag-dispatcher.js";
import { parseWorkflowSource } from "../../src/orchestration/workflow-spec-v1.js";
import { recoverAllActiveRuns, resumeRecoveredDurableCommandGateways, getActiveRun } from "../../src/runtime/active-runs.js";
import { subscribe } from "../../src/events/bus.js";
import { loadRunSnapshot } from "../../src/persistence/store.js";
import { getDb } from "../../src/persistence/db.js";

const [root, mode] = process.argv.slice(2);
process.env.HOMERAIL_HOME = path.join(root, "manager-home");
process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = process.execPath.toLowerCase();
const dispatcher = new FakeDAGDispatcher();
const executor = new GraphExecutor(dispatcher);
const record = () => ({ pid: process.pid, session: getActiveRun("root")?.nodeSessions.get("ci"),
  snapshot: loadRunSnapshot("root"), model_dispatches: dispatcher.dispatched.length,
  commands: getDb().prepare("SELECT execution_id, identity_json, consumed, owner_epoch FROM dag_durable_commands").all() });
const keepAlive = setInterval(() => {}, 1000);
subscribe("dag:run_completed", () => {
  // run_completed is emitted inside the consume transaction; capture its
  // committed row on the next event-loop turn, not from inside apply().
  setImmediate(() => {
    fs.writeFileSync(path.join(root, "ci-manager-proof.json"), JSON.stringify(record()));
    clearInterval(keepAlive);
  });
});
if (mode === "start") {
  const workflow = { api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: "ci-manager-restart", name: "CI Manager restart" }, spec: {
    agents: {}, contracts: { Task: { type: "string" } }, nodes: {
      ci: { kind: "command", inputs: { task: { contract: "Task" } }, outputs: { ready: {}, failed: {} },
        config: { command: [process.execPath, "--import", "tsx", path.resolve("tests/fixtures/e2e-ci-observer.ts"), root],
          cwd: process.cwd(), durable: true, timeout_ms: 30000, capture_limit: 65536,
          success_port: "ready", failure_port: "failed", parse_stdout: "json", result_payload: "value" } },
      done: { kind: "terminal", outcome: "success", inputs: { result: {} } },
      failed: { kind: "terminal", outcome: "failure", inputs: { result: {} } },
    }, edges: [{ from: "$run.input", to: "ci.task" }, { from: "ci.ready", to: "done.result" },
      { from: "ci.failed", to: "failed.result", condition: "on_failure" }] } };
  executor.createRun("root", parseWorkflowSource(JSON.stringify(workflow)), JSON.stringify("observe original owned CI"));
  executor.tick("root");
  fs.writeFileSync(path.join(root, "start-ci-manager.json"), JSON.stringify(record()));
} else {
  const recovery = recoverAllActiveRuns();
  if (!recovery.recovered.includes("root")) throw new Error(JSON.stringify(recovery));
  fs.writeFileSync(path.join(root, "recover-ci-manager.json"), JSON.stringify(record()));
  resumeRecoveredDurableCommandGateways(dispatcher);
}

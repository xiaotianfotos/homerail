#!/usr/bin/env node

/**
 * Local-only Browser Renderer QA fixture.
 *
 * It starts the real Manager in this process so stdin commands can invoke the
 * production Host Manager tool adapter without adding a test HTTP endpoint.
 * Run the static Agent UI separately against the printed Manager URL.
 */

import readline from "node:readline";

const port = Number(process.env.HOMERAIL_MANAGER_PORT || "19391");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("HOMERAIL_MANAGER_PORT must be a valid TCP port");
}
if (!process.env.HOMERAIL_HOME) {
  throw new Error("HOMERAIL_HOME must point to an isolated QA directory");
}

process.env.HOMERAIL_MANAGER_HOST ||= "127.0.0.1";
process.env.HOMERAIL_LOCAL_NODE_AUTOSTART ||= "0";

const [
  { createServer },
  { getBrowserRendererToolsBroker },
  { createManagerTools, emptyVoiceSurface },
  { writeRunMetadata },
  { closeDb },
] = await Promise.all([
  import("../homerail_manager/dist/server/http.js"),
  import("../homerail_manager/dist/server/browser-renderer-tools-websocket.js"),
  import("../homerail_manager/dist/server/host-codex-manager-agent.js"),
  import("../homerail_manager/dist/persistence/store.js"),
  import("../homerail_manager/dist/persistence/db.js"),
]);

const runId = "web-renderer-e2e-run";
writeRunMetadata(runId, {
  runId,
  workflowId: "web-renderer-e2e-workflow",
  workflowName: "Web Renderer E2E DAG",
  createdAt: Date.now(),
  status: "active",
  nodeStates: { "qa-node": "RUNNING" },
  handoffedNodes: [],
  graph: {
    nodes: [{
      node_id: "qa-node",
      name: "Renderer bridge verification",
      description: "A local-only node used to verify exact DAG navigation.",
      node_type: "task",
      agent: "manager",
      after: [],
      outputs: {},
    }],
    edges: [],
  },
});

const server = createServer(port, undefined, undefined, false, { autoDetectCodex: false });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function exactConnection(connectionId) {
  if (typeof connectionId !== "string" || !connectionId) {
    throw new Error("connection_id is required; QA never guesses a browser target");
  }
  const broker = getBrowserRendererToolsBroker();
  const target = broker?.connection(connectionId);
  if (!target) throw new Error("the exact browser renderer connection is unavailable");
  return target;
}

async function invokeManagerTool(command) {
  const target = exactConnection(command.connection_id);
  const tools = createManagerTools({
    restUrl: `http://127.0.0.1:${port}/api`,
    workspace: process.env.HOMERAIL_HOME,
    sessionId: "browser-renderer-e2e-session",
    createdRunIds: [],
    finalNotes: [],
    objectiveToolCalls: [],
    voiceSurface: emptyVoiceSurface(),
    browserToolsTransport: "renderer",
    browserToolsTarget: target,
  }, "chat");
  const tool = tools.find((candidate) => candidate.name === command.name);
  if (!tool) throw new Error(`Manager tool is unavailable for this exact target: ${command.name}`);
  return tool.handler(command.input ?? {});
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => server.close(() => resolve()));
  closeDb();
}

emit({
  event: "ready",
  manager_url: `http://127.0.0.1:${port}`,
  run_id: runId,
  workflow_name: "Web Renderer E2E DAG",
});

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on("line", (line) => {
  queue = queue.then(async () => {
    let command;
    try {
      command = JSON.parse(line);
      if (command?.command === "status") {
        emit({
          event: "status",
          connections: getBrowserRendererToolsBroker()?.connections() ?? [],
        });
        return;
      }
      if (command?.command === "invoke") {
        emit({
          event: "result",
          request_id: command.request_id ?? null,
          result: await invokeManagerTool(command),
        });
        return;
      }
      if (command?.command === "shutdown") {
        await stop();
        emit({ event: "stopped" });
        input.close();
        return;
      }
      throw new Error("unsupported QA command");
    } catch (error) {
      emit({
        event: "error",
        request_id: command?.request_id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(0));
  });
}

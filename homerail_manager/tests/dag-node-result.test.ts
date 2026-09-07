import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { subscribe, _clearListeners } from "../src/events/bus.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence, initEventLogging } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function joinReviewYaml(): string {
  return `
name: node-result
agents:
  worker:
    agent_type: deterministic
nodes:
  prepare:
    type: command_gateway
    gateway_config:
      command: [node, -e, "process.stdout.write('ready')"]
      timeout_ms: 5000
    outputs:
      passed:
        to: voter_one.in:task
      failed:
        to: ""
  voter_one:
    agent: worker
    outputs:
      vote:
        to: join.in:one
  voter_two:
    agent: worker
    outputs:
      vote:
        to: join.in:two
  join:
    type: join_gateway
    gateway_config:
      mode: all
      field: decision
      success_values: [approve]
      passed_port: accepted
      failed_port: rejected
    after: [voter_one, voter_two]
    outputs:
      accepted:
        to: ""
      rejected:
        to: ""
`;
}

describe("DAG node result API", () => {
  let server: http.Server;
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldAllowlist: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldAllowlist = process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-node-result-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = "node";
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
    // _clearListeners also drops the bus subscribers that persist events to
    // SQLite; restore them so telemetry events remain readable from snapshots.
    initEventLogging();
    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
  });

  afterEach(async () => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
    await close(server);
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldAllowlist === undefined) delete process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST;
    else process.env.HOMERAIL_DAG_COMMAND_ALLOWLIST = oldAllowlist;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function nodeResult(port: number, runId: string, nodeId: string): Promise<{ status: number; body: Record<string, any> }> {
    const response = await fetch(`http://127.0.0.1:${port}/api/dag-status/${runId}/node/${nodeId}/result`);
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  it("serves structured command and join results per node", async () => {
    const runId = "run-node-result";
    const gatewayEvents: Array<Record<string, any>> = [];
    const unsubscribe = subscribe("dag:gateway_executed", (payload) => {
      gatewayEvents.push(payload as Record<string, any>);
    });
    createActiveRun(runId, parseDAGYaml(joinReviewYaml()));

    // The command gateway executes synchronously once dispatched; the two
    // voters have no `after` dependencies, so they dispatch in the same pass.
    expect(dispatchReadyNodes(runId, new FakeDAGDispatcher())).toBe(3);
    handoffActiveRun(runId, "voter_one", "vote", { decision: "approve" });
    handoffActiveRun(runId, "voter_two", "vote", { decision: "approve" });
    expect(dispatchReadyNodes(runId, new FakeDAGDispatcher())).toBe(1);

    const port = await listen(server);

    const command = await nodeResult(port, runId, "prepare");
    expect(command.status).toBe(200);
    expect(command.body.data).toMatchObject({
      node_id: "prepare",
      node_type: "command_gateway",
      result_kind: "command",
      status: "completed",
    });
    expect(command.body.data.handoffs).toHaveLength(1);
    expect(command.body.data.latest).toMatchObject({
      port: "passed",
      content: expect.objectContaining({
        ok: true,
        command: "node",
        exit_code: 0,
        stdout: "ready",
      }),
    });
    expect(command.body.data.latest.timestamp).toEqual(expect.any(String));

    const join = await nodeResult(port, runId, "join");
    expect(join.status).toBe(200);
    expect(join.body.data).toMatchObject({
      node_id: "join",
      node_type: "join_gateway",
      result_kind: "join",
      status: "completed",
    });
    expect(join.body.data.latest).toMatchObject({
      port: "accepted",
      content: expect.objectContaining({
        mode: "all",
        total: 2,
        successes: 2,
        failures: 0,
        passed: true,
      }),
    });

    const worker = await nodeResult(port, runId, "voter_one");
    expect(worker.status).toBe(200);
    expect(worker.body.data).toMatchObject({
      result_kind: "worker",
      latest: { port: "vote", content: { decision: "approve" } },
    });

    // Live events now carry the structured result for in-flight UI updates.
    const joinEvent = gatewayEvents.find((event) => event.nodeId === "join");
    expect(joinEvent).toMatchObject({
      gatewayType: "join_gateway",
      port: "accepted",
      result: expect.objectContaining({ successes: 2, passed: true }),
    });
    unsubscribe();
  });

  it("exposes the command telemetry envelope when only the parsed value is handed off", async () => {
    const runId = "run-node-result-value";
    createActiveRun(runId, parseDAGYaml(`
name: node-result-value
agents: {}
nodes:
  check:
    type: command_gateway
    gateway_config:
      command: [node, -e, "process.stdout.write(JSON.stringify({verdict:'pass'}))"]
      timeout_ms: 5000
      parse_stdout: json
      result_payload: value
    outputs:
      passed:
        to: ""
      failed:
        to: ""
`));
    expect(dispatchReadyNodes(runId, new FakeDAGDispatcher())).toBe(1);

    const port = await listen(server);
    const { status, body } = await nodeResult(port, runId, "check");
    expect(status).toBe(200);
    // Handoff carries only the parsed value...
    expect(body.data.latest).toMatchObject({ port: "passed", content: { verdict: "pass" } });
    // ...while telemetry retains the full envelope for display.
    expect(body.data.telemetry).toMatchObject({
      ok: true,
      exit_code: 0,
      value: { verdict: "pass" },
    });
  });

  it("returns an empty result for a node that has not handed off yet", async () => {
    const runId = "run-node-result-pending";
    createActiveRun(runId, parseDAGYaml(joinReviewYaml()));
    const port = await listen(server);
    const { status, body } = await nodeResult(port, runId, "voter_two");
    expect(status).toBe(200);
    expect(body.data).toMatchObject({
      node_id: "voter_two",
      result_kind: "worker",
      status: "ready",
      latest: null,
      handoffs: [],
    });
  });

  it("rejects unknown runs and nodes", async () => {
    const runId = "run-node-result-missing";
    createActiveRun(runId, parseDAGYaml(joinReviewYaml()));
    const port = await listen(server);
    expect((await nodeResult(port, "no-such-run", "join")).status).toBe(404);
    expect((await nodeResult(port, runId, "no_such_node")).status).toBe(404);
  });

  it("returns 404 instead of crashing on malformed percent-encoding", async () => {
    const runId = "run-node-result-encoding";
    createActiveRun(runId, parseDAGYaml(joinReviewYaml()));
    const port = await listen(server);
    // %ZZ 不是合法的 percent-encoding；decodeURIComponent 会抛 URIError，
    // 路由必须兜成 404 而不是冒泡成未捕获异常
    expect((await nodeResult(port, runId, "%ZZ")).status).toBe(404);
    expect((await nodeResult(port, "%ZZ", "join")).status).toBe(404);
  });
});

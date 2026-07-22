import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _clearListeners, subscribe } from "../src/events/bus.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearAllPersistence, appendChatEntry } from "../src/persistence/store.js";
import {
  _clearActiveRuns,
  createActiveRun,
  dispatchReadyNodes,
  failActiveRun,
  handoffActiveRun,
} from "../src/runtime/active-runs.js";

function singleNodeYaml(): string {
  return `
name: live-events
agents:
  worker:
    agent_type: deterministic
nodes:
  start:
    name: Start Node
    agent: worker
    outputs:
      done:
        to: ""
`;
}

function terminalFailureYaml(): string {
  return `
name: live-events-failure
agents:
  worker:
    agent_type: deterministic
nodes:
  start:
    agent: worker
    outputs:
      done:
        to: ""
`;
}

function lastMatching<T extends Record<string, unknown>>(
  values: T[],
  predicate: (value: T) => boolean,
): T | undefined {
  for (let i = values.length - 1; i >= 0; i--) {
    if (predicate(values[i])) return values[i];
  }
  return undefined;
}

describe("DAG live event contract", () => {
  let tmpHome: string;
  let oldHome: string | undefined;
  let statusUpdates: Record<string, unknown>[];
  let nodeChanges: Record<string, unknown>[];

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-dag-live-events-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
    statusUpdates = [];
    nodeChanges = [];
    subscribe("dag:status_update", (payload) => {
      statusUpdates.push(payload as Record<string, unknown>);
    });
    subscribe("dag:node_state_changed", (payload) => {
      nodeChanges.push(payload as Record<string, unknown>);
    });
  });

  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
    _clearListeners();
    closeDb();
    if (oldHome === undefined) {
      delete process.env.HOMERAIL_HOME;
    } else {
      process.env.HOMERAIL_HOME = oldHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("emits frontend-compatible status and node state events across a successful run", () => {
    const parsed = parseDAGYaml(singleNodeYaml());

    createActiveRun("run-live-success", parsed);

    expect(statusUpdates).toHaveLength(1);
    expect(statusUpdates[0]).toMatchObject({
      runId: "run-live-success",
      run_id: "run-live-success",
      dag_run_id: "run-live-success",
      status: "running",
      nodes: [
        {
          id: "start",
          name: "Start Node",
          status: "ready",
        },
      ],
    });

    const dispatched = dispatchReadyNodes("run-live-success", new FakeDAGDispatcher());
    expect(dispatched).toBe(1);
    expect(nodeChanges).toContainEqual(expect.objectContaining({
      runId: "run-live-success",
      run_id: "run-live-success",
      dag_run_id: "run-live-success",
      nodeId: "start",
      node_id: "start",
      node_name: "Start Node",
      previousStatus: "ready",
      previous_status: "ready",
      status: "running",
    }));

    const run = handoffActiveRun("run-live-success", "start", "done", "ok");
    expect(run?.status).toBe("completed");

    expect(nodeChanges).toContainEqual(expect.objectContaining({
      run_id: "run-live-success",
      dag_run_id: "run-live-success",
      node_id: "start",
      previous_status: "running",
      status: "completed",
    }));
    expect(lastMatching(statusUpdates, (event) => event.run_id === "run-live-success")).toMatchObject({
      run_id: "run-live-success",
      dag_run_id: "run-live-success",
      status: "completed",
      nodes: [
        {
          id: "start",
          name: "Start Node",
          status: "completed",
        },
      ],
    });
  });

  it("emits failed run status for terminal node errors", () => {
    const parsed = parseDAGYaml(terminalFailureYaml());
    createActiveRun("run-live-failure", parsed);

    const run = failActiveRun("run-live-failure", "start", "agent failed");

    expect(run?.status).toBe("failed");
    expect(nodeChanges).toContainEqual(expect.objectContaining({
      run_id: "run-live-failure",
      dag_run_id: "run-live-failure",
      node_id: "start",
      previous_status: "ready",
      status: "failed",
    }));
    expect(lastMatching(statusUpdates, (event) => event.run_id === "run-live-failure")).toMatchObject({
      run_id: "run-live-failure",
      dag_run_id: "run-live-failure",
      status: "failed",
      nodes: [
        {
          id: "start",
          status: "failed",
        },
      ],
    });
  });

  it("emits a lightweight invalidation after a chat entry is committed", () => {
    const updates: Record<string, unknown>[] = [];
    subscribe("dag:node_chat_updated", (payload) => {
      updates.push(payload as Record<string, unknown>);
    });
    createActiveRun("run-live-chat", parseDAGYaml(singleNodeYaml()));

    appendChatEntry("run-live-chat", "start", {
      role: "worker",
      type: "response",
      content: { event: "assistant_text", text: "working" },
      timestamp: Date.now(),
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      runId: "run-live-chat",
      nodeId: "start",
    });
    expect(updates[0]?.timestamp).toEqual(expect.any(String));
  });
});

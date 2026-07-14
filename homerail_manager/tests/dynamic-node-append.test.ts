import { afterEach, describe, expect, it } from "vitest";

import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { FakeDAGDispatcher } from "../src/orchestration/dag-dispatcher.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import type { ParsedDAG } from "../src/orchestration/graph.js";
import { _clearAllPersistence } from "../src/persistence/store.js";
import { _clearActiveRuns } from "../src/runtime/active-runs.js";

function parsedDag(): ParsedDAG {
  return {
    meta: {
      agents: {
        root: {
          agent_type: "deterministic",
          system: "HANDOFF port=done content=root complete",
        },
      },
    },
    graph: {
      nodes: [
        {
          node_id: "root",
          name: "Root",
          agent: "root",
          after: [],
          outputs: { done: { to: "" } },
        },
      ],
      edges: [],
    },
    loop_sources: [],
  };
}

describe("dynamic node append", () => {
  afterEach(() => {
    _clearActiveRuns();
    _clearAllPersistence();
  });

  it("requires explicit agent configuration", () => {
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("run-dynamic", parsedDag());
    const orchestrator = new ChangeOrchestrator(executor);

    expect(() => orchestrator.appendNode("run-dynamic", { nodeId: "observer" }))
      .toThrow(/requires explicit agent configuration/);

    const run = executor.getRun("run-dynamic")!;
    expect(run.dagRun.graph.nodes.map((node) => node.node_id)).toEqual(["root"]);
    expect(run.agents?.["observer-agent"]).toBeUndefined();
  });

  it("appends a dynamic node when agent configuration is explicit", () => {
    const executor = new GraphExecutor(new FakeDAGDispatcher());
    executor.createRun("run-dynamic", parsedDag());
    const orchestrator = new ChangeOrchestrator(executor);

    const result = orchestrator.appendNode("run-dynamic", {
      nodeId: "observer",
      after: ["root"],
      agent: {
        agent_type: "deterministic",
        system: "HANDOFF port=done content=observer complete",
      },
    });

    expect(result.nodeId).toBe("observer");
    expect(result.nodeCount).toBe(2);
    const run = executor.getRun("run-dynamic")!;
    expect(run.agents?.["observer-agent"]).toMatchObject({
      agent_type: "deterministic",
    });
  });
});

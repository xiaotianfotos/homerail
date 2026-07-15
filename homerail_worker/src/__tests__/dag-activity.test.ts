import { describe, expect, it, vi } from "vitest";
import type { DagActivityEventV1, DagNodeConfig } from "homerail-protocol";
import { createDagActivityEmitter } from "../dag-activity.js";
import { createDagTools, createDagToolsState } from "../dag-tools/index.js";

function config(overrides: Partial<DagNodeConfig> = {}): DagNodeConfig {
  return {
    node_id: "researcher",
    agent_type: "deterministic",
    model: "test",
    outgoing_edges: [{ from_port: "done", to_port: "in", to_node: "writer" }],
    incoming_edges: [],
    graph_nodes: ["researcher", "writer"],
    ...overrides,
  };
}

describe("DAG activity emitter", () => {
  it("preserves actor identity and continues a supplied generation sequence", () => {
    const events: DagActivityEventV1[] = [];
    const emitter = createDagActivityEmitter(config({
      actor_id: "research-actor",
      round_id: "round-2",
      generation: 3,
      lease_generation: 7,
      surface_id: "surface-news",
      activity_sequence_start: 7,
    }), "run-1", (event) => events.push(event));

    emitter.emit("started");
    emitter.emit("finding", { message: "source verified" });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      schema_version: 1,
      run_id: "run-1",
      round_id: "round-2",
      node_id: "researcher",
      actor_id: "research-actor",
      generation: 3,
      lease_generation: 7,
      surface_id: "surface-news",
      sequence: 8,
      type: "started",
    });
    expect(events[1]).toMatchObject({ sequence: 9, type: "finding" });
    expect(events[0].event_id).not.toBe(events[1].event_id);
    expect(emitter.currentSequence()).toBe(9);
  });

  it("uses stable current-runtime defaults when actor metadata is absent", () => {
    const events: DagActivityEventV1[] = [];
    const emitter = createDagActivityEmitter(config({ session_id: "session-round" }), "run-2", (event) => events.push(event));

    emitter.emit("progress", { message: "working" });

    expect(events[0]).toMatchObject({
      actor_id: "researcher",
      round_id: "session-round",
      generation: 1,
      sequence: 1,
    });
  });

  it("falls back safely when untrusted routing counters are invalid", () => {
    const events: DagActivityEventV1[] = [];
    const emitter = createDagActivityEmitter(config({
      generation: Number.NaN,
      activity_sequence_start: -1,
    }), "run-invalid", (event) => events.push(event));

    emitter.emit("started");

    expect(events[0]).toMatchObject({ generation: 1, sequence: 1 });
  });
});

describe("report_activity tool", () => {
  it("emits only supported structured activity", async () => {
    const wsSend = vi.fn();
    const state = createDagToolsState(config(), "run-3", wsSend);
    const emit = vi.fn();
    const tool = createDagTools(state, { activityEmitter: emit }).find((candidate) => candidate.name === "report_activity");
    expect(tool).toBeDefined();

    const result = await tool!.handler({
      type: "finding",
      message: "  two sources agree  ",
      data: { sources: 2 },
    });

    expect(result.is_error).not.toBe(true);
    expect(emit).toHaveBeenCalledWith("finding", {
      message: "two sources agree",
      data: { sources: 2 },
    });
    expect(wsSend).not.toHaveBeenCalled();
  });

  it("rejects invalid activity without emitting", async () => {
    const state = createDagToolsState(config(), "run-4", vi.fn());
    const emit = vi.fn();
    const tool = createDagTools(state, { activityEmitter: emit }).find((candidate) => candidate.name === "report_activity")!;

    const result = await tool.handler({ type: "completed", message: "not allowed" });

    expect(result.is_error).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });

  it("enforces the message limit in the handler as well as the tool schema", async () => {
    const state = createDagToolsState(config(), "run-5", vi.fn());
    const emit = vi.fn();
    const tool = createDagTools(state, { activityEmitter: emit }).find((candidate) => candidate.name === "report_activity")!;

    const result = await tool.handler({ type: "progress", message: "x".repeat(4001) });

    expect(result.is_error).toBe(true);
    expect(emit).not.toHaveBeenCalled();
  });
});

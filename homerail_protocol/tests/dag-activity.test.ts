import { describe, expect, it } from "vitest";
import {
  DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
  DAG_ACTIVITY_EVENT_V1_SCHEMA_ID,
  DAG_ACTIVITY_TYPES,
  DAG_AGENT_TOOL_NAMES,
  DAG_NODE_ERROR_SCHEMA_ID,
  DAG_TRANSPORT_FENCE_CAPABILITY,
  DAG_TRANSPORT_FENCE_PROTOCOL_VERSION,
  DAG_TRANSPORT_FENCE_SCHEMA_ID,
  DAG_TRANSPORT_FENCE_V1_CAPABILITY,
  DAG_TRANSPORT_FENCE_V1_PROTOCOL_VERSION,
  DAG_TRANSPORT_FENCE_V1_SCHEMA_ID,
  type DagActivityEventV1,
  type DagNodeErrorMessage,
  validateDagActivityEventV1,
} from "../src/index.js";
import { allSchemas } from "../src/schemas.js";
import { validateMessage } from "../src/validation.js";

function activity(overrides: Partial<DagActivityEventV1> = {}): DagActivityEventV1 {
  return {
    schema_version: DAG_ACTIVITY_EVENT_SCHEMA_VERSION,
    event_id: "event-01",
    run_id: "run-01",
    round_id: "round-01",
    node_id: "worker-01",
    actor_id: "researcher",
    generation: 1,
    lease_generation: 3,
    surface_id: "surface-news",
    sequence: 1,
    timestamp: 1_784_000_000_000,
    type: "progress",
    payload: {
      message: "Checking primary sources",
      percent: 25,
      source_ids: ["source-a", "source-b"],
      detail: { cached: false, note: null },
    },
    ...overrides,
  };
}

describe("Worker Activity Event V1", () => {
  it("registers the versioned schema", () => {
    expect(DAG_ACTIVITY_EVENT_V1_SCHEMA_ID).toBe("dag-activity-event-v1");
    expect(allSchemas[DAG_ACTIVITY_EVENT_V1_SCHEMA_ID]).toBeDefined();
  });

  it.each(DAG_ACTIVITY_TYPES)("accepts the %s activity type", (type) => {
    expect(validateDagActivityEventV1(activity({ type }))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("accepts an omitted surface and nested JSON payload", () => {
    const event = activity();
    delete event.surface_id;

    expect(validateMessage(event, DAG_ACTIVITY_EVENT_V1_SCHEMA_ID).valid).toBe(true);
  });

  it("rejects an invalid physical lease generation", () => {
    expect(validateDagActivityEventV1(activity({ lease_generation: 0 }))).toMatchObject({ valid: false });
  });

  it("exposes report_activity as a DAG agent tool", () => {
    expect(DAG_AGENT_TOOL_NAMES).toContain("report_activity");
  });

  it.each([
    ["missing event id", { event_id: undefined }],
    ["empty actor id", { actor_id: "" }],
    ["unknown activity type", { type: "heartbeat" }],
    ["future schema version", { schema_version: 2 }],
    ["zero generation", { generation: 0 }],
    ["fractional generation", { generation: 1.5 }],
    ["unsafe generation", { generation: Number.MAX_SAFE_INTEGER + 1 }],
    ["zero sequence", { sequence: 0 }],
    ["fractional sequence", { sequence: 1.5 }],
    ["unsafe sequence", { sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative timestamp", { timestamp: -1 }],
    ["fractional timestamp", { timestamp: 1.5 }],
    ["unsafe timestamp", { timestamp: Number.MAX_SAFE_INTEGER + 1 }],
    ["array payload", { payload: [] }],
    ["scalar payload", { payload: "not-structured" }],
  ])("rejects %s", (_name, overrides) => {
    const candidate = { ...activity(), ...overrides };
    expect(validateMessage(candidate, DAG_ACTIVITY_EVENT_V1_SCHEMA_ID).valid).toBe(false);
  });

  it("rejects unknown envelope fields", () => {
    const candidate = { ...activity(), secret: "must-not-cross-the-wire" };
    const result = validateMessage(candidate, DAG_ACTIVITY_EVENT_V1_SCHEMA_ID);

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.keyword === "additionalProperties")).toBe(true);
  });

  it("rejects non-JSON payload values", () => {
    const candidate = activity({
      payload: { callback: (() => undefined) as never },
    });

    expect(validateMessage(candidate, DAG_ACTIVITY_EVENT_V1_SCHEMA_ID).valid).toBe(false);
  });
});

describe("DAG activity routing metadata", () => {
  const config = {
    node_id: "worker-01",
    agent_type: "claude",
    model: "model",
    outgoing_edges: [],
    incoming_edges: [],
    graph_nodes: ["worker-01"],
    round_id: "round-02",
    actor_id: "researcher",
    generation: 2,
    lease_generation: 3,
    command_id: "command-02",
    surface_id: "surface-news",
    activity_sequence_start: 41,
  };

  it("accepts optional routing metadata in DAG node config", () => {
    expect(validateMessage(config, "dag-node-config").valid).toBe(true);
    expect(validateMessage({ ...config, activity_sequence_start: 0 }, "dag-node-config").valid).toBe(true);
  });

  it.each([
    ["round_id", ""],
    ["actor_id", ""],
    ["generation", 0],
    ["lease_generation", 0],
    ["command_id", ""],
    ["surface_id", ""],
    ["activity_sequence_start", -1],
    ["activity_sequence_start", 1.5],
    ["activity_sequence_start", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects invalid %s metadata", (key, value) => {
    expect(validateMessage({ ...config, [key]: value }, "dag-node-config").valid).toBe(false);
  });
});

describe("DAG terminal transport fence", () => {
  const fencedError: DagNodeErrorMessage = {
    type: "node_error",
    data: {
      runId: "run-02",
      nodeId: "worker-01",
      message: "agent failed",
      session_id: "session-01",
      round_id: "round-02",
      actor_id: "researcher",
      generation: 2,
      lease_generation: 3,
      command_id: "command-02",
    },
  };

  it("exports an explicit versioned Worker capability", () => {
    expect(DAG_TRANSPORT_FENCE_PROTOCOL_VERSION).toBe(2);
    expect(DAG_TRANSPORT_FENCE_CAPABILITY).toBe("dag-transport-fence-v2");
    expect(DAG_TRANSPORT_FENCE_SCHEMA_ID).toBe(DAG_TRANSPORT_FENCE_CAPABILITY);
    expect(DAG_TRANSPORT_FENCE_V1_PROTOCOL_VERSION).toBe(1);
    expect(DAG_TRANSPORT_FENCE_V1_CAPABILITY).toBe("dag-transport-fence-v1");
    expect(DAG_TRANSPORT_FENCE_V1_SCHEMA_ID).toBe(DAG_TRANSPORT_FENCE_V1_CAPABILITY);
    expect(allSchemas[DAG_TRANSPORT_FENCE_V1_SCHEMA_ID]).toBeDefined();
    expect(allSchemas[DAG_TRANSPORT_FENCE_SCHEMA_ID]).toBeDefined();
    expect(allSchemas[DAG_NODE_ERROR_SCHEMA_ID]).toBeDefined();
  });

  it("validates complete v1 and lease-fenced v2 envelopes", () => {
    expect(validateMessage({
      round_id: "round-02",
      actor_id: "researcher",
      generation: 2,
      command_id: "command-02",
    }, DAG_TRANSPORT_FENCE_V1_SCHEMA_ID).valid).toBe(true);
    expect(validateMessage({
      round_id: "round-02",
      actor_id: "researcher",
      generation: 2,
      lease_generation: 3,
      command_id: "command-02",
    }, DAG_TRANSPORT_FENCE_SCHEMA_ID).valid).toBe(true);
    expect(validateMessage(fencedError, DAG_NODE_ERROR_SCHEMA_ID).valid).toBe(true);
  });

  it("keeps legacy round-one node_error compatible while rejecting malformed metadata", () => {
    expect(validateMessage({
      type: "node_error",
      data: { runId: "run-01", nodeId: "worker-01", message: "legacy failure" },
    }, DAG_NODE_ERROR_SCHEMA_ID).valid).toBe(true);
    expect(validateMessage({
      ...fencedError,
      data: { ...fencedError.data, generation: 0 },
    }, DAG_NODE_ERROR_SCHEMA_ID).valid).toBe(false);
    expect(validateMessage({
      round_id: "round-02",
      actor_id: "researcher",
      generation: 2,
      lease_generation: 0,
    }, DAG_TRANSPORT_FENCE_SCHEMA_ID).valid).toBe(false);
  });
});

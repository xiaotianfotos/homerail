/**
 * Unit tests for DAG core logic — ported from homerail_cli/src/dag.rs tests
 */

import { describe, expect, it } from "vitest";
import {
  classifyInterventionDirection,
  classifyNodes,
  computeStalledHint,
  countNodeStatuses,
  extractHandoffs,
  extractInterventions,
  eventMatches,
  normalizedPollIntervalSecs,
  truncateChars,
  renderSnapshot,
  renderSnapshotJson,
  renderHandoffs,
} from "../src/dag.js";
import type { DagSnapshot } from "../src/dag.js";

// -- normalizedPollIntervalSecs -----------------------------------------------

describe("normalizedPollIntervalSecs", () => {
  it("preserves long values", () => {
    expect(normalizedPollIntervalSecs(30)).toBe(30);
    expect(normalizedPollIntervalSecs(30.1)).toBeCloseTo(30.1);
    expect(normalizedPollIntervalSecs(60)).toBe(60);
    expect(normalizedPollIntervalSecs(300)).toBe(300);
  });

  it("clamps short values", () => {
    expect(normalizedPollIntervalSecs(0.1)).toBe(0.5);
    expect(normalizedPollIntervalSecs(0.5)).toBe(0.5);
    expect(normalizedPollIntervalSecs(-10)).toBe(0.5);
  });
});

// -- extractInterventions ---------------------------------------------------

describe("extractInterventions", () => {
  it("returns empty for empty input", () => {
    expect(extractInterventions([])).toEqual([]);
  });

  it("extracts a single intervention", () => {
    const events = [
      {
        event_type: "dag:instruction_injected",
        node_id: "coder",
        details: {
          mode: "inbox",
          instruction_preview: "fix typo",
        },
      },
    ];
    const result = extractInterventions(events) as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    expect(result[0].node_id).toBe("coder");
    expect(result[0].mode).toBe("inbox");
    expect(result[0].entry).toBe("inject:inbox");
    expect(result[0].instruction_preview).toBe("fix typo");
  });

  it("extracts multiple interventions and skips non-injection events", () => {
    const events = [
      {
        event_type: "dag:node_started",
        node_id: "triage",
        details: {},
      },
      {
        event_type: "dag:instruction_injected",
        node_id: "coder",
        details: {
          mode: "inbox",
          instruction_preview: "first fix",
        },
      },
      {
        event_type: "dag:handoff",
        node_id: "coder",
        details: { from_node: "coder", from_port: "done" },
      },
      {
        event_type: "dag:instruction_injected",
        node_id: "coder",
        details: {
          mode: "redispatched",
          instruction_preview: "second fix",
        },
      },
      {
        event_type: "dag:instruction_injected",
        node_id: "tester",
        details: {
          mode: "inbox",
          instruction_preview: "run tests",
        },
      },
    ];
    const result = extractInterventions(events) as Record<string, unknown>[];
    expect(result).toHaveLength(3);
    expect(result[0].node_id).toBe("coder");
    expect(result[0].mode).toBe("inbox");
    expect(result[1].node_id).toBe("coder");
    expect(result[1].mode).toBe("redispatched");
    expect(result[2].node_id).toBe("tester");
    expect(result[2].mode).toBe("inbox");
    expect(result[2].direction).toBe("enforce_validation");
  });

  it("handles fallback fields (type and data)", () => {
    const events = [
      {
        type: "dag:instruction_injected",
        node_id: "reviewer",
        data: {
          mode: "queued",
          instruction: "check diff",
        },
      },
    ];
    const result = extractInterventions(events) as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    expect(result[0].node_id).toBe("reviewer");
    expect(result[0].mode).toBe("queued");
    expect(result[0].entry).toBe("inject:queued");
    expect(result[0].instruction_preview).toBe("check diff");
    expect(result[0].direction).toBe("quality_review");
  });

  it("handles missing details with unknown mode", () => {
    const events = [
      {
        event_type: "dag:instruction_injected",
        details: {},
      },
    ];
    const result = extractInterventions(events) as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe("unknown");
    expect(result[0].instruction_preview).toBe("");
    expect(result[0].direction).toBe("unknown");
  });
});

// -- classifyInterventionDirection ------------------------------------------

describe("classifyInterventionDirection", () => {
  it("classifies validation keywords", () => {
    expect(
      classifyInterventionDirection("inbox", "please run pytest and verify output"),
    ).toBe("enforce_validation");
  });

  it("classifies handoff correction keywords", () => {
    expect(
      classifyInterventionDirection("redispatch", "fix the handoff contract port"),
    ).toBe("handoff_correction");
  });

  it("classifies scope narrowing keywords", () => {
    expect(
      classifyInterventionDirection("interrupt", "\u6536\u7a84\u8303\u56f4\uff0c\u53ea\u6539 scorecard"),
    ).toBe("scope_narrowing");
  });

  it("classifies environment unblock keywords", () => {
    expect(
      classifyInterventionDirection("inbox", "install missing dependency in docker"),
    ).toBe("environment_unblock");
  });

  it("returns unknown for unrecognized patterns", () => {
    expect(
      classifyInterventionDirection("inbox", "hello world"),
    ).toBe("unknown");
  });
});

// -- classifyNodes ----------------------------------------------------------

describe("classifyNodes", () => {
  it("classifies nodes by status", () => {
    const nodes = {
      triage: { status: "completed" },
      coder: { status: "running" },
      tester: { status: "ready" },
      reviewer: { status: "failed" },
    };
    const [running, ready, failed] = classifyNodes(nodes);
    expect(running).toEqual(["coder"]);
    expect(ready).toEqual(["tester"]);
    expect(failed).toEqual(["reviewer"]);
  });

  it("returns empty arrays for empty input", () => {
    const [running, ready, failed] = classifyNodes({});
    expect(running).toEqual([]);
    expect(ready).toEqual([]);
    expect(failed).toEqual([]);
  });
});

// -- countNodeStatuses -----------------------------------------------------

describe("countNodeStatuses", () => {
  it("counts node statuses correctly", () => {
    const nodes = {
      triage: { status: "completed" },
      coder: { status: "running" },
      tester: { status: "running" },
    };
    expect(countNodeStatuses(nodes)).toEqual({
      completed: 1,
      running: 2,
    });
  });
});

// -- computeStalledHint ----------------------------------------------------

describe("computeStalledHint", () => {
  it("returns terminal for completed run", () => {
    expect(computeStalledHint("completed", null, [], [], [], [], false, false)).toBe("terminal");
  });

  it("returns run_status_api_error on error", () => {
    expect(computeStalledHint("error", null, [], [], [], [], true, false)).toBe("run_status_api_error: error");
  });

  it("returns dag_status_api_error on dag error", () => {
    expect(computeStalledHint("running", null, [], [], [], [], false, true)).toBe("dag_status_api_error");
  });

  it("returns run_running_but_no_ready when running but no ready nodes", () => {
    expect(computeStalledHint("running", null, ["coder"], [], [], [], false, false)).toBe("run_running_but_no_ready: coder");
  });

  it("returns running_nodes hint when there are also ready nodes", () => {
    expect(computeStalledHint("running", null, ["coder"], ["tester"], [], [], false, false)).toBe("running_nodes: coder");
  });

  it("returns running_nodes hint when status is not running", () => {
    expect(computeStalledHint("pending", null, ["coder"], [], [], [], false, false)).toBe("running_nodes: coder");
  });

  it("returns ready_not_dispatched hint", () => {
    expect(computeStalledHint("running", null, [], ["tester"], [], [], false, false)).toBe("ready_not_dispatched: tester");
  });

  it("returns no_events for empty events", () => {
    expect(computeStalledHint("pending", null, [], [], [], [], false, false)).toBe("no_events");
  });
});

// -- extractHandoffs -------------------------------------------------------

describe("extractHandoffs", () => {
  it("extracts dag:handoff events", () => {
    const events = [
      {
        event_type: "dag:handoff",
        node_id: "triage",
        details: {
          from_node: "triage",
          content: "Source Issue: #1\nArtifact: plan",
        },
      },
      {
        event_type: "dag:node_started",
        node_id: "coder",
      },
    ];
    const result = extractHandoffs(events, 100) as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("handoff");
    expect(result[0].node).toBe("triage");
  });

  it("extracts TS Manager camelCase handoff payloads", () => {
    const events = [
      {
        type: "dag:handoff",
        event_type: "handoff",
        node_id: "coder",
        payload: {
          runId: "run-1",
          fromNode: "coder",
          port: "done",
        },
      },
    ];
    const result = extractHandoffs(events, 100) as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    expect(result[0].node).toBe("coder");
    expect(result[0].port).toBe("done");
  });

  it("extracts hook:handoff_contract events", () => {
    const events = [
      {
        event_type: "hook:handoff_contract",
        node_id: "coder",
        details: {
          from_node: "coder",
          content_preview: "contract check passed",
        },
      },
    ];
    const result = extractHandoffs(events, 200) as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("hook");
    expect(result[0].content).toBe("contract check passed");
  });

  it("respects content limit", () => {
    const longContent = "x".repeat(100);
    const events = [
      {
        event_type: "dag:handoff",
        details: { from_node: "triage", content: longContent },
      },
    ];
    const result = extractHandoffs(events, 10) as Record<string, unknown>[];
    expect((result[0].content as string).endsWith("...")).toBe(true);
    expect((result[0].content as string).length).toBeLessThanOrEqual(13); // 10 chars + "..."
  });

  it("returns empty for non-handoff events", () => {
    const events = [
      { event_type: "dag:node_started", node_id: "triage" },
    ];
    expect(extractHandoffs(events, 100)).toEqual([]);
  });
});

// -- eventMatches ----------------------------------------------------------

describe("eventMatches", () => {
  const ev = {
    event_type: "dag:handoff",
    node_id: "coder",
    details: {
      from_node: "coder",
      from_port: "done",
    },
  };

  it("matches on event type", () => {
    expect(eventMatches(ev, "dag:handoff")).toBe(true);
    expect(eventMatches(ev, "dag:node_started")).toBe(false);
  });

  it("matches on node", () => {
    expect(eventMatches(ev, undefined, "coder")).toBe(true);
    expect(eventMatches(ev, undefined, "triage")).toBe(false);
  });

  it("matches on port", () => {
    expect(eventMatches(ev, undefined, undefined, "done")).toBe(true);
    expect(eventMatches(ev, undefined, undefined, "error")).toBe(false);
  });

  it("matches on all filters combined", () => {
    expect(eventMatches(ev, "dag:handoff", "coder", "done")).toBe(true);
  });

  it("matches when no filters are provided", () => {
    expect(eventMatches(ev)).toBe(true);
  });
});

// -- truncateChars ---------------------------------------------------------

describe("truncateChars", () => {
  it("does not truncate short strings", () => {
    expect(truncateChars("hello", 10)).toBe("hello");
  });

  it("truncates long strings", () => {
    expect(truncateChars("hello world", 5)).toBe("hello...");
  });
});

// -- Rendering parity -------------------------------------------------------

describe("renderSnapshot", () => {
  it("renders a snapshot to human-readable text", () => {
    const snap: DagSnapshot = {
      run_id: "run-001",
      run_status: "running",
      waiting_for_command: false,
      current_round_id: null,
      current_phase: "execute",
      dag_status: "active",
      node_counts: { running: 1, completed: 1 },
      nodes: {},
      running_nodes: ["coder"],
      ready_nodes: [],
      failed_nodes: [],
      event_count: 5,
      latest_events: [],
      stalled_hint: "running_nodes: coder",
      workflow_id: null,
      template: null,
    };
    const text = renderSnapshot(snap);
    expect(text).toContain("DAG Quick: run-001");
    expect(text).toContain("Run: running");
    expect(text).toContain("running: 1, completed: 1");
    expect(text).toContain("Running: coder");
    expect(text).toContain("Hint: running_nodes: coder");
  });
});

describe("renderSnapshotJson", () => {
  it("renders a snapshot to JSON matching Rust render_snapshot_json shape", () => {
    const snap: DagSnapshot = {
      run_id: "run-001",
      run_status: "completed",
      waiting_for_command: false,
      current_round_id: null,
      current_phase: null,
      dag_status: "done",
      node_counts: { completed: 3 },
      nodes: {},
      running_nodes: [],
      ready_nodes: [],
      failed_nodes: [],
      event_count: 10,
      latest_events: [],
      stalled_hint: "terminal",
      workflow_id: "selfdev",
      template: null,
    };
    const json = JSON.parse(renderSnapshotJson(snap));
    expect(json.run_id).toBe("run-001");
    expect(json.run_status).toBe("completed");
    expect(json.node_counts).toEqual({ completed: 3 });
    expect(json.stalled_hint).toBe("terminal");
    expect(json.workflow_id).toBe("selfdev");
  });
});

describe("renderHandoffs", () => {
  it("renders handoffs to text", () => {
    const handoffs = [
      { kind: "handoff", type: "dag:handoff", node: "triage", content: "plan" },
    ];
    const text = renderHandoffs("run-001", handoffs);
    expect(text).toContain("DAG Handoffs: run-001");
    expect(text).toContain("[0] dag:handoff from triage: plan");
  });

  it("shows empty message when no handoffs", () => {
    const text = renderHandoffs("run-001", []);
    expect(text).toContain("No handoff events found.");
  });
});

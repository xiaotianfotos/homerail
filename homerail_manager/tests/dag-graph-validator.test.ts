import { describe, expect, it } from "vitest";

import { validateGraph } from "../src/orchestration/graph-validator.js";
import { parseDAGYaml } from "../src/orchestration/yaml-loader.js";

describe("DAG graph validator", () => {
  it("accepts terminal edges", () => {
    const parsed = parseDAGYaml(`
name: terminal-ok
nodes:
  start:
    agent: planner
    outputs:
      done:
        to: ""
`);

    const result = validateGraph(parsed.graph);

    expect(result.valid).toBe(true);
    expect(result.entry_nodes).toEqual(["start"]);
    expect(result.terminal_nodes).toEqual(["start"]);
  });

  it("rejects output edges that reference unknown nodes", () => {
    expect(() => parseDAGYaml(`
name: dangling-edge
nodes:
  start:
    agent: planner
    outputs:
      done:
        to: "missing.in:task"
`)).toThrow(/unknown to_node: missing/);
  });

  it("rejects non-failure cycles before runtime dispatch", () => {
    expect(() => parseDAGYaml(`
name: cyclic
nodes:
  first:
    agent: a
    outputs:
      done:
        to: "second.in:task"
  second:
    agent: b
    outputs:
      done:
        to: "first.in:task"
`)).toThrow(/Cycle detected: first -> second -> first/);
  });

  it("allows on_failure feedback edges without reporting a cycle", () => {
    const result = validateGraph({
      nodes: [
        {
          node_id: "first",
          name: "first",
          description: "",
          node_type: "agent",
          agent: "a",
          after: [],
          outputs: {},
        },
        {
          node_id: "second",
          name: "second",
          description: "",
          node_type: "agent",
          agent: "b",
          after: [],
          outputs: {},
        },
      ],
      edges: [
        {
          from_node: "first",
          from_port: "done",
          to_node: "second",
          to_port: "task",
          condition: "on_success",
        },
        {
          from_node: "second",
          from_port: "error",
          to_node: "first",
          to_port: "retry",
          condition: "on_failure",
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.entry_nodes).toEqual(["first"]);
  });

  it("reports orphan nodes as warnings, not hard errors", () => {
    const result = validateGraph({
      nodes: [
        {
          node_id: "main",
          name: "main",
          description: "",
          node_type: "agent",
          agent: "a",
          after: [],
          outputs: {},
        },
        {
          node_id: "orphan",
          name: "orphan",
          description: "",
          node_type: "agent",
          agent: "b",
          after: [],
          outputs: {},
        },
      ],
      edges: [
        {
          from_node: "main",
          from_port: "done",
          to_node: "",
          to_port: "",
          condition: "on_success",
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain("Orphan node (no edges): orphan");
  });

  it("reports non-terminal dead-end nodes as warnings", () => {
    const parsed = parseDAGYaml(`
name: dead-end-warning
nodes:
  start:
    agent: a
    outputs:
      done:
        to: "middle.in:task"
  middle:
    agent: b
`);

    const result = validateGraph(parsed.graph);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain("Dead-end node (no terminal or outgoing edges): middle");
  });

  it("treats await_command as a non-terminal suspension boundary without requiring feedback", () => {
    const parsed = parseDAGYaml(`
name: await-command-boundary
nodes:
  actor:
    agent: worker
    outputs:
      summary: { to: suspend.in:summary }
  suspend:
    type: await_command_gateway
    gateway_config:
      primitive_version: 1
      target_actors: [actor]
      expires_after_ms: 60000
      command_port: next_command
  finisher:
    agent: worker
    outputs:
      done: { to: "" }
`);

    const result = validateGraph(parsed.graph);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).not.toContain("Dead-end node (no terminal or outgoing edges): suspend");
    expect(result.terminal_nodes).toEqual(["finisher"]);
    expect(parsed.loop_sources).toEqual([]);
  });

  it.each([
    ["primitive_version: 2", /requires primitive_version 1/],
    ["primitive_version: 1\n      expires_after_ms: 999", /expires_after_ms to be an integer of at least 1000/],
    ["primitive_version: 1\n      command_port: Invalid.Port", /invalid command_port identifier/],
    ["primitive_version: 1\n      unexpected: true", /unsupported config fields: unexpected/],
    ["primitive_version: 1\n      target_actors: [actor, actor]", /duplicate target actor: actor/],
  ])("rejects invalid legacy await_command config: %s", (config, expected) => {
    expect(() => parseDAGYaml(`
name: invalid-await-command
nodes:
  actor: { agent: worker }
  suspend:
    type: await_command_gateway
    gateway_config:
      ${config}
`)).toThrow(expected);
  });

  it("rejects legacy await_command output routes", () => {
    expect(() => parseDAGYaml(`
name: invalid-await-command-output
nodes:
  suspend:
    type: await_command_gateway
    gateway_config: { primitive_version: 1 }
    outputs:
      resumed: { to: "" }
`)).toThrow(/does not support output routes/);
  });

  it("rejects legacy downstream dependencies from await_command", () => {
    expect(() => parseDAGYaml(`
name: invalid-await-command-dependent
nodes:
  actor:
    agent: worker
    outputs:
      summary: { to: suspend.in:summary }
  suspend:
    type: await_command_gateway
    gateway_config:
      primitive_version: 1
      target_actors: [actor]
  after_suspend:
    agent: worker
    after: [suspend]
    outputs:
      done: { to: "" }
`)).toThrow(/await_command suspend cannot have outgoing edges or downstream dependents/i);
  });

  it.each([
    ["suspend", /cannot target itself/],
    ["gate", /must reference an agent node/],
    ["missing", /references unknown target actor: missing/],
  ])("rejects legacy await_command target actor %s", (targetActor, expected) => {
    expect(() => parseDAGYaml(`
name: invalid-await-command-target
nodes:
  actor: { agent: worker }
  gate: { type: command_gateway }
  suspend:
    type: await_command_gateway
    gateway_config:
      primitive_version: 1
      target_actors: [${targetActor}]
`)).toThrow(expected);
  });

  it("warns when high-retry on_failure feedback edges can loop", () => {
    const parsed = parseDAGYaml(`
name: feedback-risk-warning
nodes:
  first:
    agent: a
    outputs:
      done:
        to: "second.in:task"
  second:
    agent: b
    outputs:
      done:
        to: ""
      error:
        to: "first.in:retry"
        condition: on_failure
        retry_policy:
          max_retries: 11
`);

    const result = validateGraph(parsed.graph);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain(
      "Feedback-loop risk: on_failure edge second.error -> first.retry has max_retries 11",
    );
  });

  it("allows a bounded feedback cycle that targets a while gateway", () => {
    const parsed = parseDAGYaml(`
name: valid-while-cycle
nodes:
  work:
    agent: worker
    after: [gate]
    outputs:
      measured:
        to: gate.in:measurement
        retry_policy:
          max_retries: 2
  gate:
    type: while_gateway
    gateway_config:
      operator: eq
      value: done
      max_iterations: 2
    outputs:
      continue:
        to: work.in:task
      done:
        to: ""
      exhausted:
        to: ""
`);

    const result = validateGraph(parsed.graph);
    expect(result.valid).toBe(true);
    expect(result.entry_nodes).toEqual(["gate"]);
    expect(parsed.loop_sources).toContain("gate");
  });

  it("rejects invalid join, while, and retry configurations before runtime", () => {
    expect(() => parseDAGYaml(`
name: invalid-join
agents:
  worker:
    agent_type: deterministic
nodes:
  voter:
    agent: worker
    outputs:
      vote:
        to: join.in:vote
  join:
    type: join_gateway
    gateway_config:
      mode: n_of_m
      threshold: 0
    after: [voter]
    outputs:
      passed:
        to: ""
`)).toThrow(/positive integer threshold/);

    expect(() => parseDAGYaml(`
name: invalid-while
nodes:
  gate:
    type: while_gateway
    gateway_config:
      operator: approximately
      max_iterations: 0
    outputs:
      done:
        to: ""
`)).toThrow(/unsupported operator/);

    expect(() => parseDAGYaml(`
name: invalid-retry
nodes:
  start:
    agent: worker
    outputs:
      done:
        to: ""
        retry_policy:
          max_retries: -1
`)).toThrow(/non-negative integer/);
  });

  it("rejects join gateways without a complete dependency input contract", () => {
    expect(() => parseDAGYaml(`
name: join-without-dependencies
nodes:
  join:
    type: join_gateway
    outputs:
      passed:
        to: ""
`)).toThrow(/requires at least one after dependency/);

    expect(() => parseDAGYaml(`
name: join-with-missing-input
agents:
  worker:
    agent_type: deterministic
nodes:
  voter_one:
    agent: worker
    outputs:
      vote:
        to: join.in:one
  voter_two:
    agent: worker
    outputs:
      done:
        to: ""
  join:
    type: join_gateway
    after: [voter_one, voter_two]
    outputs:
      passed:
        to: ""
`)).toThrow(/missing routed input from after dependencies: voter_two/);

    expect(() => parseDAGYaml(`
name: join-with-unawaited-input
agents:
  worker:
    agent_type: deterministic
nodes:
  awaited_voter:
    agent: worker
    outputs:
      vote:
        to: join.in:awaited
  unawaited_voter:
    agent: worker
    outputs:
      vote:
        to: join.in:unawaited
  join:
    type: join_gateway
    after: [awaited_voter]
    outputs:
      passed:
        to: ""
`)).toThrow(/routed input from undeclared after dependencies: unawaited_voter/);

    expect(() => parseDAGYaml(`
name: join-with-impossible-threshold
agents:
  worker:
    agent_type: deterministic
nodes:
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
      mode: n_of_m
      threshold: 3
    after: [voter_one, voter_two]
    outputs:
      passed:
        to: ""
`)).toThrow(/threshold 3 exceeds its 2 after dependencies/);
  });
});

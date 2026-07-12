import { describe, expect, it } from "vitest";
import YAML from "yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { compileWorkflowSource, parseWorkflowSourceFile } from "../src/orchestration/workflow-spec-v1.js";
import { WorkflowSpecV1Schema } from "../src/orchestration/workflow-spec-v1-schema.js";

const PUBLIC_V1_ASSETS = [
  "workflow-spec-v1-minimal.yaml.template",
  "workflow-spec-v1-fanout.yaml.template",
  "workflow-spec-v1-condition.yaml.template",
  "workflow-spec-v1-foreach.yaml.template",
  "workflow-spec-v1-bounded-while.yaml.template",
] as const;

const MINIMAL_WORKFLOW = {
  api_version: "homerail.ai/v1",
  kind: "Workflow",
  metadata: {
    id: "bounded-review",
    name: "Bounded Review",
  },
  spec: {
    description: "Execute one task and finish with explicit evidence.",
    workspace: { mode: "isolated" },
    contracts: {
      Task: {
        type: "object",
        additionalProperties: false,
        required: ["objective"],
        properties: { objective: { type: "string", maxLength: 1000 } },
      },
      Result: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: { status: { type: "string", enum: ["success", "failure"] } },
      },
    },
    agents: {
      worker: {
        system: "Execute the supplied task and return structured evidence.",
        skills: ["homerail-dag-ops"],
      },
    },
    nodes: {
      execute: {
        kind: "agent",
        agent: "worker",
        inputs: { task: { contract: "Task" } },
        outputs: { result: { contract: "Result" } },
      },
      done: {
        kind: "terminal",
        outcome: "success",
        inputs: { result: { contract: "Result" } },
      },
    },
    edges: [
      { from: "$run.input", to: "execute.task" },
      { from: "execute.result", to: "done.result" },
    ],
  },
} as const;

describe("WorkflowSpec v1", () => {
  it("defines a strict schema branch for every v1 node kind", () => {
    const document = {
      api_version: "homerail.ai/v1",
      kind: "Workflow",
      metadata: { id: "all-node-kinds", name: "All Node Kinds" },
      spec: {
        contracts: { Data: { type: "object" } },
        agents: { worker: { system: "Work." } },
        nodes: {
          worker: {
            kind: "agent",
            agent: "worker",
            inputs: { task: { contract: "Data" } },
            outputs: { result: { contract: "Data" } },
          },
          gate: {
            kind: "condition",
            inputs: { signal: { contract: "Data" } },
            outputs: { yes: { contract: "Data" }, no: { contract: "Data" } },
            config: { field: "status", routes: { yes: "yes", no: "no" }, default: "no" },
          },
          join: {
            kind: "join",
            inputs: { votes: { contract: "Data" } },
            outputs: { passed: { contract: "Data" }, failed: { contract: "Data" } },
            config: { mode: "n_of_m", field: "vote", threshold: 2 },
          },
          each: {
            kind: "foreach",
            inputs: { items: { contract: "Data" }, result: { contract: "Data" } },
            outputs: { next: { contract: "Data" }, done: { contract: "Data" } },
            config: { input: "items", item_port: "next", result_port: "result", done_port: "done", max_items: 100 },
          },
          bounded: {
            kind: "while",
            inputs: { state: { contract: "Data" } },
            outputs: { again: { contract: "Data" }, done: { contract: "Data" } },
            config: {
              field: "complete",
              operator: "truthy",
              continue_port: "again",
              done_port: "done",
              max_iterations: 3,
            },
          },
          terminal: {
            kind: "terminal",
            outcome: "success",
            inputs: { result: { contract: "Data" } },
          },
        },
        edges: [],
      },
    };

    expect(Value.Check(WorkflowSpecV1Schema, document)).toBe(true);
    for (const [nodeId, node] of Object.entries(document.spec.nodes)) {
      const invalid = structuredClone(document) as any;
      invalid.spec.nodes[nodeId] = { ...node, unsupported_field: true };
      expect(Value.Check(WorkflowSpecV1Schema, invalid), nodeId).toBe(false);
    }
  });

  it("compiles equivalent YAML and JSON to byte-identical canonical IR", () => {
    const yaml = compileWorkflowSource(YAML.stringify(MINIMAL_WORKFLOW));
    const json = compileWorkflowSource(JSON.stringify(MINIMAL_WORKFLOW, null, 2));

    expect(yaml.valid, yaml.diagnostics.map((item) => item.message).join("\n")).toBe(true);
    expect(json.valid, json.diagnostics.map((item) => item.message).join("\n")).toBe(true);
    expect(yaml.canonical_json).toBe(json.canonical_json);
    expect(yaml.canonical_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(yaml.canonical_hash).toBe(json.canonical_hash);
    expect(yaml.summary).toEqual({
      workflow_id: "bounded-review",
      node_count: 2,
      edge_count: 2,
      entry_nodes: ["execute"],
      terminal_nodes: ["done"],
    });
  });

  it("rejects unknown and provider-specific fields with source positions", () => {
    const source = YAML.stringify({
      ...MINIMAL_WORKFLOW,
      spec: {
        ...MINIMAL_WORKFLOW.spec,
        agents: {
          worker: {
            ...MINIMAL_WORKFLOW.spec.agents.worker,
            model: "provider-owned-model",
          },
        },
      },
    });
    const result = compileWorkflowSource(source);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        code: "DAG_SCHEMA_UNKNOWN_FIELD",
        path: "/spec/agents/worker/model",
        line: expect.any(Number),
        column: expect.any(Number),
      }),
    ]));
  });

  it("reports port contract mismatches before runtime", () => {
    const workflow = structuredClone(MINIMAL_WORKFLOW) as any;
    workflow.spec.nodes.done.inputs.result.contract = "Task";
    const result = compileWorkflowSource(YAML.stringify(workflow));

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DAG_SEMANTIC_CONTRACT_MISMATCH", path: "/spec/edges/1" }),
    ]));
  });

  it("rejects an unknown dynamic fan-out result contract", () => {
    const result = compileWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: fanout-contract, name: Fanout Contract }
spec:
  contracts: { Items: { type: array } }
  agents: { worker: { system: Work. } }
  nodes:
    fan:
      kind: fanout
      inputs: { items: { contract: Items } }
      outputs: { passed: {}, failed: {} }
      config:
        input: items
        worker_agent: worker
        max_items: 2
        max_parallelism: 1
        completion: all
        result_contract: MissingResult
        result_port: passed
        failed_port: failed
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
    failed: { kind: terminal, outcome: failure, inputs: { result: {} } }
  edges:
    - { from: $run.input, to: fan.items }
    - { from: fan.passed, to: done.result }
    - { from: fan.failed, to: failed.result, condition: on_failure }
`);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DAG_SEMANTIC_UNKNOWN_CONTRACT",
        path: "/spec/nodes/fan/config/result_contract",
      }),
    ]));
  });

  it("rejects an approval workflow that authorizes its proposer", () => {
    const result = compileWorkflowSource(`
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: self-approval, name: Self Approval }
spec:
  agents: {}
  nodes:
    approve:
      kind: approval
      outputs: { approved: {}, rejected: {} }
      config:
        approval_id: release
        proposer_actor: agent:proposer
        authorized_actors: [agent:proposer]
        approved_port: approved
        rejected_port: rejected
    done: { kind: terminal, outcome: success, inputs: { result: {} } }
    rejected: { kind: terminal, outcome: failure, inputs: { result: {} } }
  edges:
    - { from: approve.approved, to: done.result }
    - { from: approve.rejected, to: rejected.result, condition: on_failure }
`);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DAG_SEMANTIC_SELF_APPROVAL",
        path: "/spec/nodes/approve/config/authorized_actors",
      }),
    ]));
  });

  it("requires explicit terminals and rejects normal cycles", () => {
    const workflow = structuredClone(MINIMAL_WORKFLOW) as any;
    delete workflow.spec.nodes.done;
    workflow.spec.nodes.execute.inputs.feedback = { contract: "Result" };
    workflow.spec.edges[1] = { from: "execute.result", to: "execute.feedback" };
    const result = compileWorkflowSource(YAML.stringify(workflow));

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "DAG_SEMANTIC_UNBOUNDED_CYCLE",
      "DAG_SEMANTIC_TERMINAL_REQUIRED",
    ]));
  });

  it("accepts bounded feedback only when it targets a loop node", () => {
    const workflow = structuredClone(MINIMAL_WORKFLOW) as any;
    workflow.spec.nodes.loop = {
      kind: "while",
      inputs: { state: { contract: "Result" } },
      outputs: {
        again: { contract: "Result" },
        complete: { contract: "Result" },
      },
      config: {
        field: "status",
        operator: "ne",
        value: "success",
        continue_port: "again",
        done_port: "complete",
        max_iterations: 3,
      },
    };
    workflow.spec.nodes.execute.inputs.feedback = { contract: "Result" };
    workflow.spec.edges = [
      { from: "$run.input", to: "execute.task" },
      { from: "execute.result", to: "loop.state" },
      { kind: "feedback", from: "loop.again", to: "loop.state", max_traversals: 3 },
      { from: "loop.complete", to: "done.result" },
    ];
    const result = compileWorkflowSource(YAML.stringify(workflow));

    expect(result.valid, result.diagnostics.map((item) => item.message).join("\n")).toBe(true);
    expect(result.canonical?.feedback_edges).toHaveLength(1);
  });

  it("accepts existing unversioned workflows through an isolated legacy adapter", () => {
    const result = compileWorkflowSource(`
name: Legacy Review
workflow_id: legacy-review
agents:
  worker:
    system: Do the work.
nodes:
  execute:
    agent: worker
    outputs:
      done:
        to: ""
`);

    expect(result.valid, result.diagnostics.map((item) => item.message).join("\n")).toBe(true);
    expect(result.source_api_version).toBe("legacy/v0");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: "warning", code: "DAG_LEGACY_UNVERSIONED_SOURCE" }),
    ]);
    expect(result.canonical?.terminal_nodes).toHaveLength(1);
  });

  it("loads the tracked v1 template through the same path used to create runs", () => {
    const parsed = parseWorkflowSourceFile(path.resolve(
      "..",
      "assets",
      "orchestrations",
      "workflow-spec-v1-minimal.yaml.template",
    ));

    expect(parsed.meta).toMatchObject({
      workflow_id: "workflow-spec-v1-minimal",
      source_api_version: "homerail.ai/v1",
    });
    expect(parsed.graph.nodes.map((node) => node.node_id)).toEqual(["execute"]);
    expect(parsed.graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from_node: "execute", from_port: "result", to_node: "" }),
    ]));
  });

  it.each(PUBLIC_V1_ASSETS)("compiles the public v1 asset: %s", (file) => {
    const source = fs.readFileSync(path.resolve("..", "assets", "orchestrations", file), "utf8");
    const result = compileWorkflowSource(source);

    expect(result.valid, result.diagnostics.map((item) => `${item.code} ${item.path}: ${item.message}`).join("\n")).toBe(true);
    expect(result.source_api_version).toBe("homerail.ai/v1");
    expect(result.canonical_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

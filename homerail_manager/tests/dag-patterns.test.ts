import { describe, expect, it } from "vitest";
import * as path from "node:path";

import {
  DAG_PATTERN_SOURCE,
  getDAGPattern,
  instantiateDAGPattern,
  listDAGPatterns,
} from "../src/orchestration/dag-patterns.js";
import { validateJsonContract } from "../src/orchestration/json-contract.js";
import { parseDAGYamlFile } from "../src/orchestration/yaml-loader.js";

describe("built-in DAG patterns", () => {
  it("ships the complete pattern catalog with AI-readable guidance", () => {
    const patterns = listDAGPatterns();

    expect(patterns.map((pattern) => pattern.id)).toEqual([
      "heartbeat",
      "orchestrator-workers",
      "executor-advisor",
      "budget-gate",
      "trust-ledger",
      "standing-goal-sentinel",
      "quorum",
      "sparring",
      "ratchet",
      "compost",
    ]);
    for (const pattern of patterns) {
      expect(pattern.roles.length).toBeGreaterThan(1);
      expect(pattern.typical_uses.length).toBeGreaterThan(0);
      expect(pattern.avoid_when.length).toBeGreaterThan(0);
      expect(pattern.required_primitives.length).toBeGreaterThan(0);
      expect(pattern.invariants.length).toBeGreaterThan(0);
      expect(pattern.evidence_contract.required.length).toBeGreaterThan(0);
      expect(pattern.composition_ports.outputs.length).toBeGreaterThan(0);
      expect(Object.keys(pattern.failure_semantics).length).toBeGreaterThan(0);
      expect(pattern.node_count).toBeGreaterThan(1);
      expect(pattern.source).toEqual(DAG_PATTERN_SOURCE);
    }
  });

  it("exposes Executor-Advisor as a bounded callable advisor topology", () => {
    const pattern = instantiateDAGPattern("executor-advisor", { max_advisor_calls: 3 });
    const execute = pattern.parsed.graph.nodes.find((node) => node.node_id === "execute");
    const runtime = execute?.extra?.agent_runtime as Record<string, unknown> | undefined;
    expect(runtime?.advisors).toEqual([{
      id: "expert",
      agent: "advisor",
      max_calls: 3,
      timeout_ms: 120000,
      max_tokens: 64000,
    }]);
    expect(pattern.parsed.meta.agents).toHaveProperty("executor");
    expect(pattern.parsed.meta.agents).toHaveProperty("advisor");
  });

  it("reserves declared budget before dispatching expensive work", () => {
    const pattern = instantiateDAGPattern("budget-gate");
    const gate = pattern.parsed.graph.nodes.find((node) => node.node_id === "budget_gate");
    expect(gate?.gateway_config).toMatchObject({
      operation: "budget_admit",
      value_field: "expected_usage",
      budget_limit: 5,
    });
    expect(pattern.parsed.graph.nodes.some((node) => node.node_id === "record_usage")).toBe(false);
  });

  it("gives the trust verifier the original acceptance criteria", () => {
    const pattern = instantiateDAGPattern("trust-ledger");
    const verifier = pattern.parsed.meta.agents.verifier;

    expect(verifier?.system).toContain("original work request and its acceptance criteria");
    expect(pattern.workflow.spec.edges).toContainEqual({ from: "$run.input", to: "verify.work" });
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "verify")?.extra?.workflow_spec_v1)
      .toMatchObject({ input_contracts: { work: "Work" } });
    expect(pattern.parsed.graph.edges).toContainEqual(expect.objectContaining({
      from_node: "execute",
      from_port: "completed",
      to_node: "verify",
      to_port: "result",
    }));
  });

  it("instantiates every built-in pattern as valid provider-independent YAML", () => {
    for (const summary of listDAGPatterns()) {
      const instance = instantiateDAGPattern(summary.id);

      expect(instance.validation.valid).toBe(true);
      expect(instance.validation.errors).toEqual([]);
      expect(instance.parsed.meta.workflow_id).toBe(`pattern-${summary.id}`);
      expect(["isolated", "shared"]).toContain(instance.parsed.meta.workspace?.mode);
      expect(instance.parsed.meta.pattern).toMatchObject({
        id: summary.id,
        version: summary.version,
        source: DAG_PATTERN_SOURCE.url,
      });
      expect(instance.workflow).toMatchObject({
        api_version: "homerail.ai/v1",
        kind: "Workflow",
        metadata: { id: `pattern-${summary.id}` },
        spec: { pattern: { id: summary.id } },
      });
      expect(instance.yaml_text).toMatch(/^api_version: homerail\.ai\/v1/m);
      expect(instance.yaml_text).not.toMatch(/^workflow_id:/m);
      expect(instance.yaml_text).not.toMatch(/^\s*(provider|model|api_key):/m);
      expect(instance.yaml_text).not.toContain("{{");
    }
  });

  it("preserves numeric parameter types in gateway configuration", () => {
    const quorum = instantiateDAGPattern("quorum", {
      workflow_id: "release-quorum",
      threshold: 3,
    });
    const join = quorum.parsed.graph.nodes.find((node) => node.node_id === "quorum");
    expect(join?.gateway_config?.threshold).toBe(3);
    expect(quorum.parsed.meta.pattern?.parameters).toMatchObject({
      workflow_id: "release-quorum",
      threshold: 3,
    });

    const ratchet = instantiateDAGPattern("ratchet", { target: 2, max_iterations: 5 });
    const gate = ratchet.parsed.graph.nodes.find((node) => node.node_id === "target_gate");
    expect(gate?.gateway_config).toMatchObject({ value: 2, max_iterations: 5 });
    expect(ratchet.parsed.graph.edges.find(
      (edge) => edge.from_node === "monotonic_gate" && edge.to_node === "target_gate",
    )?.retry_policy?.max_retries).toBe(5);
  });

  it("makes the heartbeat verifier emit the top-level field consumed by its gateway", () => {
    const heartbeat = instantiateDAGPattern("heartbeat");
    const verifier = heartbeat.parsed.meta.agents.verifier;
    const verdictGate = heartbeat.parsed.graph.nodes.find((node) => node.node_id === "verdict_gate");
    const deterministicCheck = heartbeat.parsed.graph.nodes.find((node) => node.node_id === "deterministic_check");

    expect(verifier?.system).toContain("top-level verdict");
    expect(verifier?.system).toContain("Never nest verdict");
    for (const role of ["triage", "conductor", "worker", "verifier"] as const) {
      expect(heartbeat.parsed.meta.agents[role]?.system).toMatch(/(?:do not|never) execute check_command/i);
    }
    expect(verdictGate?.gateway_config?.field).toBe("verdict");
    expect(deterministicCheck?.gateway_config).toMatchObject({ input: "order", command_field: "check_command" });
    expect(heartbeat.parsed.graph.edges).toContainEqual(expect.objectContaining({
      from_node: "conduct",
      from_port: "ordered",
      to_node: "deterministic_check",
      to_port: "order",
    }));
    expect(validateJsonContract(heartbeat.parsed.meta.contracts?.Signals, "CLI prompt signal")).toMatchObject({
      valid: true,
    });
    expect(validateJsonContract(heartbeat.parsed.meta.contracts?.Signals, { event: "pull_request" })).toMatchObject({
      valid: true,
    });
  });

  it("uses bounded data-driven fan-out instead of a fixed worker count", () => {
    const pattern = instantiateDAGPattern("orchestrator-workers");
    const planEdges = pattern.parsed.graph.edges.filter(
      (edge) => edge.from_node === "plan" && edge.from_port === "planned" && edge.label !== "after_dep",
    );

    expect(planEdges.map((edge) => [edge.from_port, edge.to_node, edge.to_port])).toEqual([["planned", "fanout", "plan"]]);
    const fanout = pattern.parsed.graph.nodes.find((node) => node.node_id === "fanout");
    expect(fanout?.gateway_config).toMatchObject({ type: "fanout", max_items: 16, max_parallelism: 4, worker_agent: "worker" });
    expect(pattern.parsed.meta.contracts?.Plan).toMatchObject({
      properties: {
        work_items: {
          items: {
            required: ["id", "task", "acceptance_criteria"],
            properties: { acceptance_criteria: { type: "array", minItems: 1 } },
          },
        },
      },
    });
    expect(pattern.parsed.meta.contracts?.WorkerResult).toMatchObject({ required: ["status", "evidence"] });
    expect(fanout?.gateway_config?.result_contract).toBe("WorkerResult");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("1..N");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("Never precompute");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("exactly success or failed");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("non-empty JSON array of strings");
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("exact port planned");
    expect(pattern.parsed.meta.agents.worker?.system).toContain("fan-out item");
  });

  it("keeps compost proposals behind a durable human approval node", () => {
    const pattern = instantiateDAGPattern("compost");
    const approval = pattern.parsed.graph.nodes.find((node) => node.node_id === "human_review");
    expect(approval?.node_type).toBe("approval_gateway");
    expect(approval?.gateway_config).toMatchObject({
      approval_id: "compost-change",
      proposer_actor: "agent:proposer",
      authorized_actors: ["owner"],
    });
    expect(pattern.parsed.meta.agents.proposer?.system).toContain("Never approve or apply");
  });

  it("requires sparring challenge and repair evidence before downstream work", () => {
    const pattern = instantiateDAGPattern("sparring");

    expect(pattern.parsed.meta.contracts?.Challenge).toMatchObject({
      additionalProperties: false,
      required: ["artifact_path", "test_command", "evidence"],
    });
    expect(pattern.parsed.meta.contracts?.Repair).toMatchObject({
      additionalProperties: false,
      required: ["test_command", "evidence"],
    });
    expect(pattern.parsed.meta.agents.builder?.system).toContain("input:challenge.test_command");
    expect(pattern.parsed.meta.agents.builder?.system).toContain("input:correction");
    expect(pattern.parsed.meta.agents.builder?.system).toContain("fix_applied");
    expect(pattern.parsed.meta.limits?.max_corrections_per_node).toBe(3);
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "break")?.extra?.workflow_spec_v1)
      .toMatchObject({ output_contracts: { challenge: "Challenge" } });
  });

  it("requires ratchet improvers to hand measurement and rollback back to deterministic nodes", () => {
    const pattern = instantiateDAGPattern("ratchet");
    const improver = pattern.parsed.meta.agents.improver;

    expect(improver?.system).toContain("Never self-report a new metric");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "remeasure")?.node_type).toBe("command_gateway");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "previous_measurement")?.node_type).toBe("command_gateway");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "compare_measurements")?.node_type).toBe("join_gateway");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "compare_measurements")?.gateway_config?.mode).toBe("all");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "rollback_regression")?.node_type).toBe("command_gateway");
    expect(pattern.parsed.graph.nodes.find((node) => node.node_id === "enroll_floor")?.node_type).toBe("state_gateway");
  });

  it("rejects unknown, incorrectly typed, and out-of-range parameters", () => {
    expect(() => instantiateDAGPattern("missing")).toThrow("DAG pattern not found");
    expect(() => instantiateDAGPattern("quorum", { surprise: true })).toThrow("Unknown pattern parameter");
    expect(() => instantiateDAGPattern("quorum", { threshold: "2" })).toThrow("must be a finite number");
    expect(() => instantiateDAGPattern("quorum", { threshold: 2.5 })).toThrow("must be an integer");
    expect(() => instantiateDAGPattern("quorum", { threshold: 4 })).toThrow("must be at most 3");
    expect(() => instantiateDAGPattern("heartbeat", { workflow_id: "" })).toThrow("must be a non-empty string");
  });

  it("returns defensive copies of pattern definitions", () => {
    const first = getDAGPattern("quorum");
    expect(first).toBeDefined();
    first!.roles[0].responsibility = "mutated";

    expect(getDAGPattern("quorum")?.roles[0].responsibility).not.toBe("mutated");
  });

  it("keeps concrete offline pattern instances valid and isolated", () => {
    const assets = [
      ["pattern-quorum-offline.yaml", "quorum"],
      ["pattern-ratchet-exhaustion-offline.yaml", "ratchet"],
    ] as const;
    for (const [file, patternId] of assets) {
      const parsed = parseDAGYamlFile(path.resolve("..", "assets", "orchestrations", file));
      expect(parsed.meta.pattern?.id).toBe(patternId);
      expect(parsed.meta.workspace).toEqual({ mode: "isolated" });
    }
  });
});

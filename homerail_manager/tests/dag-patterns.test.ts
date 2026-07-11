import { describe, expect, it } from "vitest";
import * as path from "node:path";

import {
  DAG_PATTERN_SOURCE,
  getDAGPattern,
  instantiateDAGPattern,
  listDAGPatterns,
} from "../src/orchestration/dag-patterns.js";
import { parseDAGYamlFile } from "../src/orchestration/yaml-loader.js";

describe("built-in DAG patterns", () => {
  it("ships the complete pattern catalog with AI-readable guidance", () => {
    const patterns = listDAGPatterns();

    expect(patterns.map((pattern) => pattern.id)).toEqual([
      "heartbeat",
      "orchestrator-workers",
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
      expect(pattern.node_count).toBeGreaterThan(1);
      expect(pattern.source).toEqual(DAG_PATTERN_SOURCE);
    }
  });

  it("instantiates every built-in pattern as valid provider-independent YAML", () => {
    for (const summary of listDAGPatterns()) {
      const instance = instantiateDAGPattern(summary.id);

      expect(instance.validation.valid).toBe(true);
      expect(instance.validation.errors).toEqual([]);
      expect(instance.parsed.meta.workflow_id).toBe(`pattern-${summary.id}`);
      expect(instance.parsed.meta.workspace).toEqual({ mode: "isolated" });
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
      expect(instance.yaml_text).not.toMatch(/provider:|model:|api_key:/);
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
      (edge) => edge.from_node === "improve" && edge.to_node === "target_gate",
    )?.retry_policy?.max_retries).toBe(5);
  });

  it("makes the heartbeat verifier emit the top-level field consumed by its gateway", () => {
    const heartbeat = instantiateDAGPattern("heartbeat");
    const verifier = heartbeat.parsed.meta.agents.verifier;
    const verdictGate = heartbeat.parsed.graph.nodes.find((node) => node.node_id === "verdict_gate");

    expect(verifier?.system).toContain("top-level verdict");
    expect(verifier?.system).toContain("Never nest verdict");
    expect(verdictGate?.gateway_config?.field).toBe("verdict");
  });

  it("fans out one indexed plan while requiring each worker to select only its own work order", () => {
    const pattern = instantiateDAGPattern("orchestrator-workers");
    const planEdges = pattern.parsed.graph.edges.filter(
      (edge) => edge.from_node === "plan" && edge.from_port === "planned" && edge.label !== "after_dep",
    );

    expect(planEdges.map((edge) => [edge.from_port, edge.to_node, edge.to_port]).sort((left, right) => left[1].localeCompare(right[1]))).toEqual([
      ["planned", "worker_one", "order"],
      ["planned", "worker_three", "order"],
      ["planned", "worker_two", "order"],
    ]);
    expect(pattern.parsed.meta.agents.orchestrator?.system).toContain("work_orders object is keyed");
    expect(pattern.parsed.meta.agents.worker?.system).toContain("may arrive as a JSON string");
    expect(pattern.parsed.meta.agents.worker?.system).toContain("work_orders[current_node_id]");
    expect(pattern.parsed.meta.agents.worker?.system).toContain("handoff tool on result");
    expect(pattern.parsed.meta.agents.worker?.system).toContain("top-level status");
  });

  it("keeps compost proposals behind an explicit human-review handoff", () => {
    const pattern = instantiateDAGPattern("compost");
    const reviewer = pattern.parsed.meta.agents.reviewer;

    expect(reviewer?.system).toContain("not the human decision maker");
    expect(reviewer?.system).toContain("handoff tool on done");
    expect(reviewer?.system).toContain("top-level status awaiting_human_review");
    expect(reviewer?.system).toContain("review_boundary is human_review");
    expect(reviewer?.system).toContain("every proposal has status awaiting_human_review");
    expect(reviewer?.system).toContain("Never emit approved, rejected, signed, or applied status");
  });

  it("requires ratchet improvers to preserve an upstream synthetic scope", () => {
    const pattern = instantiateDAGPattern("ratchet");
    const improver = pattern.parsed.meta.agents.improver;

    expect(improver?.system).toContain("preserve the scope declared by the upstream evidence");
    expect(improver?.system).toContain("synthetic or in-memory");
    expect(improver?.system).toContain("never inspect or modify the workspace");
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

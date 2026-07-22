import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileWorkflowSource,
} from "../src/orchestration/workflow-spec-v1.js";

const WORKFLOW_FILE = path.resolve(
  import.meta.dirname,
  "../../assets/orchestrations/auto-fix.yaml.template",
);

describe("Auto Fix scenario asset", () => {
  it("compiles a model-neutral two-pass repair with independent final consensus", () => {
    const source = fs.readFileSync(WORKFLOW_FILE, "utf8");
    const result = compileWorkflowSource(source);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toMatchObject({
      workflow_id: "auto-fix",
      node_count: 33,
      edge_count: 56,
    });
    expect(source).not.toMatch(/^\s*(?:provider|model|llm_setting_id|api_key|base_url):/m);
    expect(source).not.toContain("qwen");
    expect(source).not.toContain("kimi");
    expect(source).not.toContain("glm");

    const canonical = result.canonical!;
    expect(canonical.nodes.every((node) => node.kind !== "command")).toBe(true);
    expect(canonical.nodes.find((node) => node.id === "verification_quorum")).toMatchObject({
      kind: "join",
      config: {
        mode: "n_of_m",
        threshold: 2,
        field: "verdict",
        success_values: ["approve"],
      },
    });
    expect(canonical.nodes.find((node) => node.id === "revise")).toMatchObject({
      kind: "agent",
      agent: "reviser",
    });
    expect(canonical.nodes.find((node) => node.id === "arbitrate")).toMatchObject({
      kind: "agent",
      agent: "arbiter",
    });
    expect(canonical.nodes.find((node) => node.id === "publish")?.config.workspace_access).toMatchObject({
      writable_paths: [".homerail-runtime"],
      readonly_paths: ["source"],
    });
    expect(canonical.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "auto-fix.json", contract: "AutoFixResult" }),
      expect.objectContaining({
        name: "auto-fix.patch",
        media_type: "text/plain",
        source: expect.objectContaining({ json_pointer: "/patch" }),
      }),
      expect.objectContaining({
        name: "auto-fix.md",
        media_type: "text/markdown",
        source: expect.objectContaining({ json_pointer: "/markdown" }),
      }),
    ]));
  });

  it("keeps GitHub mutation and host-selected test commands outside the DAG", () => {
    const source = fs.readFileSync(WORKFLOW_FILE, "utf8");
    const canonical = compileWorkflowSource(source).canonical!;

    expect(source).not.toMatch(/\b(?:gh\s+pr|git\s+push|createPullRequest|test_command)\b/i);
    expect(source).not.toMatch(/^\s*credentials:/m);
    expect(canonical.nodes.some((node) => node.kind === "command")).toBe(false);

    for (const nodeId of [
      "review_correctness_initial",
      "review_regression_initial",
      "review_adversarial_initial",
      "review_correctness_final",
      "review_regression_final",
      "review_adversarial_final",
      "arbitrate",
    ]) {
      const node = canonical.nodes.find((candidate) => candidate.id === nodeId);
      expect(node?.config.workspace_access).toMatchObject({ readonly_paths: ["source"] });
      expect(node?.config.workspace_access?.writable_paths).not.toContain("source");
    }
  });

});

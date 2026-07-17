import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/persistence/db.js";
import { assemblePluginTurnContext } from "../src/plugins/context-assembler.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";
import {
  assertManagerAgentOutcomeContractsResolvable,
  enforceManagerAgentOutcomeContracts,
  resolveManagerAgentOutcomeContracts,
} from "../src/server/manager-agent-outcomes.js";

describe("Manager Agent stable outcomes", () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-outcomes-"));
    process.env.HOMERAIL_HOME = home;
    syncBuiltinPlugins();
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("resolves a canvas capability to readable raw and Skill-template Tools", () => {
    const context = assemblePluginTurnContext(undefined, {
      modality: "voice",
      include_agent_tools: true,
    });
    const contracts = resolveManagerAgentOutcomeContracts({
      required_outcomes: ["canvas.view.committed"],
      response_mode: "voice",
      plugin_context: context,
      manager_skills: [{
        id: "route-skill",
        content: "Render the result.",
        view_templates: [{
          id: "route",
          description: "Show a route.",
          data_schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
          a2ui: {
            version: "v1.0",
            catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
            components: [{ id: "root", component: "Text", text: { path: "/data/title" } }],
          },
          defaults: {
            surface: "result",
            importance: "primary",
            density: "summary",
            canvas_size: "1x1",
            persistence: "session",
          },
        }],
      }],
    });
    expect(contracts).toHaveLength(1);
    expect(contracts[0].tool_names).toContain("upsert_generated_view");
    expect(contracts[0].tool_names.some((name) => name.startsWith("skill_view_route-skill_route_"))).toBe(true);
    expect(() => assertManagerAgentOutcomeContractsResolvable(contracts)).not.toThrow();
  });

  it("rejects a required canvas outcome before execution when no live Tool is bound", () => {
    const context = assemblePluginTurnContext(undefined, {
      modality: "text",
      include_agent_tools: false,
    });
    const contracts = resolveManagerAgentOutcomeContracts({
      required_outcomes: ["canvas.view.committed"],
      response_mode: "chat",
      plugin_context: context,
      manager_skills: [],
    });
    expect(() => assertManagerAgentOutcomeContractsResolvable(contracts)).toThrow(/unavailable/i);
  });

  it("accepts only a committed UI transaction as canvas evidence", () => {
    const contract = [{ capability: "canvas.view.committed" as const, tool_names: ["upsert_generated_view"] }];
    const committed = enforceManagerAgentOutcomeContracts({
      text: "done",
      objective: { required: false, satisfied: true },
      tool_calls: [{ id: "call-ui", name: "upsert_generated_view" }],
      tool_results: [{
        tool_use_id: "call-ui",
        content: JSON.stringify({
          success: true,
          data: {
            status: "committed",
            result: { output_type: "ui_transaction", document_id: "doc-1", document_revision: 2 },
          },
        }),
      }],
    }, contract);
    expect(committed.objective).toMatchObject({
      satisfied: true,
      required_outcomes: ["canvas.view.committed"],
      outcome_evidence: [{
        tool_name: "upsert_generated_view",
        evidence: { document_id: "doc-1", document_revision: 2 },
      }],
    });

    expect(() => enforceManagerAgentOutcomeContracts({
      text: "saved locally",
      tool_calls: [{ id: "call-ui", name: "upsert_generated_view" }],
      tool_results: [{
        tool_use_id: "call-ui",
        content: JSON.stringify({ status: "projected", committed: false }),
      }],
    }, contract)).toThrow(/did not produce required committed outcomes/i);
  });

  it("requires inspectable Artifact, Skill, and DAG evidence", () => {
    const digest = "a".repeat(64);
    const result = enforceManagerAgentOutcomeContracts({
      run_id: "run-1",
      run_ids: ["run-1"],
      tool_calls: [
        { id: "artifact", name: "publish_artifact" },
        { id: "skill", name: "read_skill" },
        { id: "dag", name: "start_supervised_dag" },
      ],
      tool_results: [
        {
          tool_use_id: "artifact",
          content: JSON.stringify({
            success: true,
            data: { artifact: { url: "/api/voice-agent/sessions/s/artifacts/a.png", digest, kind: "image" } },
          }),
        },
        {
          tool_use_id: "skill",
          content: JSON.stringify({ success: true, data: { id: "palquery", content: "# Skill", digest } }),
        },
        { tool_use_id: "dag", content: JSON.stringify({ success: true, data: { runId: "run-1" } }) },
      ],
    }, [
      { capability: "artifact.published", tool_names: ["publish_artifact"] },
      { capability: "skill.loaded", tool_names: ["read_skill"] },
      { capability: "dag.supervised.started", tool_names: ["start_supervised_dag"] },
    ]);
    expect((result.objective as Record<string, unknown>).outcome_evidence).toHaveLength(3);
  });
});

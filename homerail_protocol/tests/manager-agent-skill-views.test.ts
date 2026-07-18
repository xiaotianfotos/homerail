import { describe, expect, it } from "vitest";

import {
  MANAGER_AGENT_SKILL_VIEW_PRESENT_TOOL_NAME,
  MANAGER_AGENT_SKILL_VIEW_RENDER_TOOL_NAME,
  compactManagerAgentSkillSupervisedDagResult,
  compactManagerAgentSkillViewPresentResult,
  managerAgentSkillViewPresentToolDefinition,
  managerAgentSkillViewRenderToolDefinition,
  matchingManagerAgentSkillViewToolDefinition,
  managerAgentSkillViewToolDefinitions,
  managerAgentSkillViewToolName,
  materializeManagerAgentSkillViewInput,
  materializeManagerAgentSkillViewTemplateInput,
  normalizeManagerAgentSkillSupervisedDagLaunch,
  type ManagerAgentSkillViewTemplateV1,
} from "../src/manager-agent-skill-views.js";

const template: ManagerAgentSkillViewTemplateV1 = {
  id: "profile",
  description: "Show one entity with a compact visual summary.",
  data_schema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      summary: { type: "string", maxLength: 1000 },
      value: { type: "number" },
    },
    required: ["title", "value"],
    additionalProperties: false,
  },
  a2ui: {
    version: "v1.0",
    catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
    components: [
      { id: "root", component: "Column", children: ["title", "value"] },
      { id: "title", component: "Text", text: { path: "/data/title" } },
      { id: "value", component: "HrMetric", label: "Value", value: { path: "/data/value" } },
    ],
  },
  defaults: {
    surface: "result",
    importance: "primary",
    density: "summary",
    canvas_size: "1x1",
    persistence: "session",
  },
  allowed_canvas_sizes: ["1x1", "1x2"],
};

describe("Manager Agent Skill view templates", () => {
  it("exposes one compact trusted presenter Tool", () => {
    const definition = managerAgentSkillViewPresentToolDefinition();
    expect(definition.name).toBe(MANAGER_AGENT_SKILL_VIEW_PRESENT_TOOL_NAME);
    expect(definition.input_schema).toMatchObject({
      type: "object",
      required: ["skill_id", "argv"],
      additionalProperties: false,
      properties: {
        skill_id: { type: "string" },
        argv: { type: "array", minItems: 1, maxItems: 32 },
      },
    });
    expect(definition.description).toContain("without a shell");
    expect(definition.description).toContain("start its supervised DAG in one call");
    expect(definition.description).toContain("do not call skill_view_render or start_supervised_dag again");
  });

  it("normalizes and compacts a trusted supervised DAG launch", () => {
    const launch = normalizeManagerAgentSkillSupervisedDagLaunch({
      mode: "supervised_dag",
      launch: {
        workflow_id: "three-worker",
        profile: "local-model",
        prompt: "verified evidence",
        workflow_revision: 3,
        canonical_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        profile_updated_at: "2026-07-18T00:00:00.000Z",
      },
    });
    expect(launch).toEqual({
      workflow_id: "three-worker",
      profile: "local-model",
      prompt: "verified evidence",
      workflow_revision: 3,
      canonical_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile_updated_at: "2026-07-18T00:00:00.000Z",
    });
    expect(compactManagerAgentSkillSupervisedDagResult({
      success: true,
      data: { run_id: "run-three", dispatched: 3, internal: "omitted" },
    }, launch!, "Three panels are updating.")).toEqual({
      mode: "supervised_dag",
      run_id: "run-three",
      workflow_id: "three-worker",
      workflow_revision: 3,
      canonical_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile: "local-model",
      response_text: "Three panels are updating.",
    });
    expect(normalizeManagerAgentSkillSupervisedDagLaunch({ mode: "visual" })).toBeUndefined();
    expect(() => normalizeManagerAgentSkillSupervisedDagLaunch({
      mode: "supervised_dag",
      launch: { workflow_id: "three-worker", prompt: "" },
    })).toThrow(/invalid supervised Skill DAG launch/);
  });

  it("keeps presenter Tool results compact while preserving committed evidence", () => {
    expect(compactManagerAgentSkillViewPresentResult({
      success: true,
      data: {
        status: "committed",
        result: {
          output_type: "ui_transaction",
          document_id: "voice-document",
          document_revision: 3,
          projection: { large: "omitted" },
        },
      },
    }, "Route ready.")).toEqual({
      success: true,
      data: {
        status: "committed",
        result: {
          output_type: "ui_transaction",
          document_id: "voice-document",
          document_revision: 3,
        },
        response_text: "Route ready.",
      },
    });
    expect(() => compactManagerAgentSkillViewPresentResult({
      success: true,
      data: { status: "projected", result: {} },
    })).toThrow(/invalid committed result/);
    expect(compactManagerAgentSkillViewPresentResult({
      execution_version: 1,
      status: "projected",
      committed: false,
      projection: { node: { id: "com.example:route" } },
    }, "Route ready.")).toEqual({
      execution_version: 1,
      status: "projected",
      committed: false,
      node_id: "com.example:route",
      response_text: "Route ready.",
    });
  });

  it("exposes one compact generic renderer independent of installed Skill schemas", () => {
    const definition = managerAgentSkillViewRenderToolDefinition();
    expect(definition.name).toBe(MANAGER_AGENT_SKILL_VIEW_RENDER_TOOL_NAME);
    expect(definition.input_schema).toMatchObject({
      type: "object",
      required: ["skill_id", "template_id", "id", "data"],
      additionalProperties: false,
      properties: {
        skill_id: { type: "string" },
        template_id: { type: "string" },
        id: { type: "string" },
        data: { type: "object" },
      },
    });
    expect(JSON.stringify(definition)).not.toContain("components");
    expect(definition.description).toContain("presenter {template:'route'");
    expect(definition.description).toContain("skill_id:'catalog'");
  });

  it("builds stable bounded Tool names and only exposes loaded Skill templates", () => {
    const name = managerAgentSkillViewToolName("palquery", "profile");
    expect(name).toMatch(/^skill_view_[a-z0-9_-]+$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(managerAgentSkillViewToolName("palquery", "profile")).toBe(name);

    const definitions = managerAgentSkillViewToolDefinitions([
      { id: "catalog-only", view_templates: [template] },
      { id: "palquery", content: "Loaded Skill", view_templates: [template] },
    ]);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.description).toContain("formatString accepts only");
    expect(definitions[0]?.description).toContain("escape a literal opener as \\${");
  });

  it("validates semantic data and materializes the trusted A2UI surface", () => {
    const definition = managerAgentSkillViewToolDefinitions([
      { id: "palquery", content: "Loaded Skill", view_templates: [template] },
    ])[0];

    expect(materializeManagerAgentSkillViewInput(definition, {
      id: "pal-profile-anubis",
      canvas_size: "1x2",
      data: { title: "Anubis", summary: "Strong worker", value: 4 },
    })).toEqual({
      id: "pal-profile-anubis",
      title: "Anubis",
      summary: "Strong worker",
      surface: "result",
      importance: "primary",
      density: "summary",
      canvas_size: "1x2",
      persistence: "session",
      content: { data: { title: "Anubis", summary: "Strong worker", value: 4 } },
      a2ui: template.a2ui,
    });

    expect(materializeManagerAgentSkillViewTemplateInput("palquery", template, {
      id: "pal-profile-anubis",
      canvas_size: "1x2",
      data: { title: "Anubis", summary: "Strong worker", value: 4 },
    })).toEqual({
      id: "pal-profile-anubis",
      title: "Anubis",
      summary: "Strong worker",
      surface: "result",
      importance: "primary",
      density: "summary",
      canvas_size: "1x2",
      persistence: "session",
      content: { data: { title: "Anubis", summary: "Strong worker", value: 4 } },
      a2ui: template.a2ui,
    });
  });

  it("rejects missing required data and unsupported canvas sizes", () => {
    const definition = managerAgentSkillViewToolDefinitions([
      { id: "palquery", content: "Loaded Skill", view_templates: [template] },
    ])[0];
    expect(() => materializeManagerAgentSkillViewInput(definition, {
      id: "pal-profile-anubis",
      data: { value: 4 },
    })).toThrow(/invalid/i);
    expect(() => materializeManagerAgentSkillViewInput(definition, {
      id: "pal-profile-anubis",
      canvas_size: "3x3",
      data: { title: "Anubis", value: 4 },
    })).toThrow(/invalid/i);
    expect(() => materializeManagerAgentSkillViewTemplateInput("palquery", template, {
      id: "pal-profile-anubis",
      data: { title: "Anubis", value: 4, invented: true },
    })).toThrow(/invalid/i);
  });

  it("detects raw generated-view data already owned by a loaded template", () => {
    const definitions = managerAgentSkillViewToolDefinitions([
      { id: "palquery", content: "Loaded Skill", view_templates: [template] },
    ]);
    const match = matchingManagerAgentSkillViewToolDefinition(definitions, {
      id: "pal-profile-anubis",
      canvas_size: "3x3",
      content: { data: { title: "Anubis", value: 4 } },
      a2ui: { version: "v1.0" },
    });
    expect(match?.name).toBe(managerAgentSkillViewToolName("palquery", "profile"));
    expect(matchingManagerAgentSkillViewToolDefinition(definitions, {
      id: "custom-view",
      content: { data: { title: "Custom", body: "Not a profile" } },
    })).toBeUndefined();
  });
});

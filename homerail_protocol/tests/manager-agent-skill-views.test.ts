import { describe, expect, it } from "vitest";

import {
  matchingManagerAgentSkillViewToolDefinition,
  managerAgentSkillViewToolDefinitions,
  managerAgentSkillViewToolName,
  materializeManagerAgentSkillViewInput,
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

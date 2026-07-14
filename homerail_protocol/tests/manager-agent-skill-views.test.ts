import { describe, expect, it } from "vitest";

import {
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
  view: {
    view_version: 1,
    root: {
      id: "root",
      type: "stack",
      children: [
        { id: "title", type: "heading", text: { path: "/data/title" } },
        { id: "value", type: "metric", label: { literal: "Value" }, value: { path: "/data/value" } },
      ],
    },
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

    expect(managerAgentSkillViewToolDefinitions([
      { id: "catalog-only", view_templates: [template] },
      { id: "palquery", content: "Loaded Skill", view_templates: [template] },
    ])).toHaveLength(1);
  });

  it("validates semantic data and materializes the trusted ViewSpec", () => {
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
      view: template.view,
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
});

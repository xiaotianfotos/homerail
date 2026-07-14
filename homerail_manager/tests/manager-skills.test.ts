import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureManagerSkillsInstalled,
  getManagerSkillsRoot,
  listManagerSkills,
  readManagerSkill,
  readManagerSkillViewTemplates,
} from "../src/server/manager-skills.js";

function writeSkill(root: string, id: string, name: string, description: string, body = "Use this skill."): void {
  const dir = path.join(root, "skills", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
    body,
    "",
  ].join("\n"), "utf8");
}

function writeViewManifest(root: string, id: string, overrides: Record<string, unknown> = {}): string {
  const dir = path.join(root, "skills", id, "assets", "homerail");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "view-templates.json");
  fs.writeFileSync(file, JSON.stringify({
    manifest_version: 1,
    templates: [{
      id: "profile",
      description: "Compact entity profile.",
      data_schema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          value: { type: "number" },
        },
        required: ["title", "value"],
        additionalProperties: false,
      },
      view: {
        view_version: 1,
        root: {
          id: "root",
          type: "metric",
          label: { path: "/data/title" },
          value: { path: "/data/value" },
        },
      },
      defaults: {
        surface: "result",
        importance: "primary",
        density: "summary",
        canvas_size: "1x1",
        persistence: "session",
      },
      ...overrides,
    }],
  }), "utf8");
  return file;
}

describe("Manager Agent skill discovery", () => {
  let tmpHome: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-manager-skills-"));
    process.env.HOMERAIL_HOME = tmpHome;
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("installs missing built-in skills as links under HOMERAIL_HOME", () => {
    const result = ensureManagerSkillsInstalled();

    expect(result.root).toBe(path.join(tmpHome, "skills"));
    expect(result.errors).toEqual([]);
    expect(result.installed).toContain("homerail-dag-patterns");
    expect(fs.realpathSync(path.join(getManagerSkillsRoot(), "homerail-dag-patterns")))
      .toBe(fs.realpathSync(path.resolve(process.cwd(), "..", "skills", "homerail-dag-patterns")));
  });

  it("discovers every home skill and lets home content override a built-in id", () => {
    writeSkill(tmpHome, "custom-operator", "custom-operator", "Custom operator workflow");
    writeSkill(
      tmpHome,
      "homerail-dag-patterns",
      "homerail-dag-patterns",
      "User-owned pattern guidance",
      "Always inspect local policy before choosing a pattern.",
    );

    const skills = listManagerSkills();

    expect(skills.find((skill) => skill.id === "custom-operator")).toMatchObject({
      description: "Custom operator workflow",
      source: "home",
      enabled: true,
    });
    expect(skills.find((skill) => skill.id === "homerail-dag-patterns")).toMatchObject({
      description: "User-owned pattern guidance",
      source: "home",
    });
    expect(readManagerSkill("homerail-dag-patterns")?.content)
      .toContain("Always inspect local policy");
  });

  it("rejects path traversal and missing skill ids", () => {
    expect(readManagerSkill("../secrets")).toBeUndefined();
    expect(readManagerSkill("missing-skill")).toBeUndefined();
  });

  it("loads only bounded validated visual templates from the selected local Skill", () => {
    writeSkill(tmpHome, "visual-skill", "visual-skill", "Visual result workflow");
    writeViewManifest(tmpHome, "visual-skill");

    const templates = readManagerSkillViewTemplates("visual-skill");
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ id: "profile" });
    expect(templates[0]).not.toHaveProperty("allowed_canvas_sizes");

    writeViewManifest(tmpHome, "visual-skill", { id: "../escape" });
    expect(readManagerSkillViewTemplates("visual-skill")).toEqual([]);
  });

  it("does not follow a view manifest symlink outside the Skill package", () => {
    writeSkill(tmpHome, "linked-view", "linked-view", "Linked visual result workflow");
    const outside = path.join(tmpHome, "outside-template.json");
    fs.writeFileSync(outside, JSON.stringify({ manifest_version: 1, templates: [] }), "utf8");
    const file = path.join(tmpHome, "skills", "linked-view", "assets", "homerail", "view-templates.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(outside, file);

    expect(readManagerSkillViewTemplates("linked-view")).toEqual([]);
  });
});

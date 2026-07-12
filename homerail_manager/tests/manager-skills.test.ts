import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureManagerSkillsInstalled,
  getManagerSkillsRoot,
  listManagerSkills,
  readManagerSkill,
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
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("installs missing built-in skills as links under HOMERAIL_HOME", () => {
    const result = ensureManagerSkillsInstalled();

    expect(result.root).toBe(path.join(tmpHome, "skills"));
    expect(result.errors).toEqual([]);
    expect(result.installed).toContain("homerail-dag-patterns");
    expect(result.installed).toContain("homerail-pr-closeout");
    expect(result.installed).toContain("homerail-pr-review");
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
});

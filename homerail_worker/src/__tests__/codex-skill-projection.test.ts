import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { _prepareCodexSkillProjectionForTest } from "../agent/codex-appserver.js";
import type { AgentRunContext } from "../agent/types.js";

describe("Codex native Skill projection", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps directory assets and materializes inline definitions", () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skill-source-"));
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skill-runtime-"));
    roots.push(source, runtime);
    const skill = path.join(source, "release-helper");
    fs.mkdirSync(path.join(skill, "references"), { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: release-helper\ndescription: release\n---\nUse the reference.\n");
    fs.writeFileSync(path.join(skill, "references", "checklist.md"), "ship it\n");

    const context = {
      model: "deepseek-v4-flash",
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      skillProjection: {
        mode: "explicit",
        directories: [source],
        definitions: [{
          id: "inline",
          name: "inline-skill",
          description: "inline",
          content: "---\nname: ignored\n---\nInline instructions.",
        }],
      },
    } satisfies AgentRunContext;

    const projected = _prepareCodexSkillProjectionForTest(context, runtime);
    expect(projected.skillCount).toBe(2);
    expect(fs.readFileSync(path.join(projected.roots[0], "release-helper", "references", "checklist.md"), "utf8"))
      .toContain("ship it");
    expect(fs.readFileSync(path.join(projected.roots[0], "inline-skill", "SKILL.md"), "utf8"))
      .toContain("Inline instructions.");
  });
});

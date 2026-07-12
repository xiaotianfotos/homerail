import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GENERATIVE_UI_IR_VERSION,
  type GenerativeUiStoredNodeV1,
} from "homerail-protocol";
import { GenerativeUiKindRegistry } from "../src/generative-ui/kind-registry.js";
import { closeDb } from "../src/persistence/db.js";
import {
  assemblePluginTurnContext,
  readArchivedPluginSkill,
} from "../src/plugins/context-assembler.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";
import { setPluginEnabled } from "../src/persistence/plugins.js";

function coreNode(): GenerativeUiStoredNodeV1 {
  return {
    ir_version: GENERATIVE_UI_IR_VERSION,
    id: "memo",
    kind: "com.homerail.core/task_summary",
    kind_version: 1,
    owner: { id: "com.homerail.core", version: "0.1.0" },
    surface: "task",
    importance: "primary",
    content: {
      legacy_widget: { id: "memo", type: "memo", title: "Current task" },
    },
    presentation: { density: "summary", preferred_visual: "memo" },
    fallback: { title: "Current task" },
    revision: 1,
    updated_at: "2026-07-11T12:00:00.000Z",
  };
}

describe("Plugin Context and Kind Registry", () => {
  let previousHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-context-"));
    process.env.HOMERAIL_HOME = tmpHome;
    syncBuiltinPlugins();
  });

  afterEach(() => {
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("assembles one deterministic immutable context before harness selection", () => {
    const first = assemblePluginTurnContext();
    const second = assemblePluginTurnContext();
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      context_version: 1,
      registry_revision: 3,
      enabled_plugins: [
        { id: "com.homerail.core", version: "0.1.0" },
        { id: "com.homerail.pr-closeout", version: "1.0.0" },
        { id: "com.homerail.topic-outline", version: "1.0.0" },
      ],
      actions: [],
      permission_revision: 0,
    });
    expect(first.skills.map((skill) => skill.qualified_id)).toEqual([
      "com.homerail.core:voice-generative-ui",
      "com.homerail.pr-closeout:pr-closeout",
      "com.homerail.topic-outline:topic-outline",
    ]);
    expect(first.tools).toHaveLength(2);
    expect(first.tools.find((tool) => tool.plugin_id === "com.homerail.topic-outline")).toMatchObject({
      plugin_id: "com.homerail.topic-outline",
      qualified_id: "com.homerail.topic-outline:upsert_topic_outline",
      wire_id: expect.stringMatching(/^p_[a-f0-9]{10}_upsert_topic_outline$/),
      description: expect.stringContaining("com.homerail.topic-outline:upsert_topic_outline"),
      effect: "write",
      permissions: [],
      confirmation: "never",
      handler: { type: "projection" },
    });
    expect(first.context_digest).toMatch(/^[a-f0-9]{64}$/);

    const text = assemblePluginTurnContext(undefined, { modality: "text" });
    expect(text.skills.some((skill) => skill.plugin_id === "com.homerail.topic-outline")).toBe(false);
    expect(text.skills.map((skill) => skill.qualified_id)).toEqual([
      "com.homerail.core:voice-generative-ui",
      "com.homerail.pr-closeout:pr-closeout",
    ]);
    expect(text.tools.map((tool) => tool.qualified_id)).toEqual(["com.homerail.pr-closeout:upsert_pr_closeout"]);
    const legacyCompatibility = assemblePluginTurnContext(undefined, {
      modality: "voice",
      legacy_compatibility_mode: true,
    });
    expect(legacyCompatibility.skills.some((skill) => skill.plugin_id === "com.homerail.topic-outline")).toBe(false);
    expect(legacyCompatibility.tools).toEqual([]);
  });

  it("reads a Skill only through the enabled exact plugin snapshot", () => {
    const skill = readArchivedPluginSkill("com.homerail.core:voice-generative-ui");
    expect(skill).toMatchObject({
      descriptor: {
        plugin_id: "com.homerail.core",
        plugin_version: "0.1.0",
        local_id: "voice-generative-ui",
      },
    });
    expect(skill?.content).toContain("Use only the tools present in the current turn's catalog");
    expect(readArchivedPluginSkill("com.homerail.core:missing")).toBeUndefined();
  });

  it("keeps archived Kind validation separate from active projections", () => {
    const registry = new GenerativeUiKindRegistry();
    expect(registry.validateHistoricalNode(coreNode())).toEqual([]);
    const invalid = coreNode();
    invalid.content = { unknown: true };
    expect(registry.validateHistoricalNode(invalid)).toContainEqual(expect.objectContaining({
      path: "/content",
      keyword: "required",
    }));
    const unknown = coreNode();
    unknown.owner.version = "9.0.0";
    expect(registry.validateHistoricalNode(unknown)).toContainEqual(expect.objectContaining({
      keyword: "kindRegistry",
    }));

    expect(registry.compositionMetadata()).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: "com.homerail.topic-outline/outline",
      kind_version: 1,
    })]));
    expect(registry.uiProjection()).toMatchObject({
      registry_revision: 3,
      kinds: expect.arrayContaining([expect.objectContaining({
        kind: "com.homerail.core/task_summary",
        enabled: true,
      })]),
      renderers: expect.arrayContaining([expect.objectContaining({
        renderer_id: "core-task-summary",
        enabled: true,
      }), expect.objectContaining({
        renderer_id: "pr-closeout-main",
        enabled: true,
      }), expect.objectContaining({
        renderer_id: "topic-outline-main",
        enabled: true,
      })]),
    });

    setPluginEnabled("com.homerail.topic-outline", false);
    const disabled = new GenerativeUiKindRegistry();
    expect(disabled.compositionMetadata().some((entry) => entry.kind === "com.homerail.topic-outline/outline"))
      .toBe(false);
    expect(disabled.uiProjection().renderers).toContainEqual(expect.objectContaining({
      renderer_id: "topic-outline-main",
      enabled: false,
    }));
    expect(assemblePluginTurnContext().tools.map((tool) => tool.qualified_id))
      .toEqual(["com.homerail.pr-closeout:upsert_pr_closeout"]);
    expect(readArchivedPluginSkill("com.homerail.topic-outline:topic-outline")).toBeUndefined();
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  managerAgentCommonToolCatalog,
  type AgentToolDefinition,
  type GenerativeUiCanvasContextV1,
  type ManagerAgentResponseMode,
  type ManagerAgentPromptSkill,
  type HomerailPluginToolExecutionEnvelopeV1,
  type HomerailPluginTurnContextV1,
} from "homerail-protocol";
import { createManagerTools as createHostCodexManagerTools } from "../src/server/host-codex-manager-agent.js";
import { createManagerTools as createWorkerManagerTools } from "../../homerail_worker/src/manager-agent/server.js";
import { closeDb } from "../src/persistence/db.js";
import { assemblePluginTurnContext } from "../src/plugins/context-assembler.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";

interface VoiceSurfaceState {
  commentaryTexts: string[];
  progress: Record<string, unknown> | null;
  taskDraft: Record<string, unknown> | null;
  widgets: Record<string, unknown>[];
  removeWidgetIds: string[];
  pluginProjections: HomerailPluginToolExecutionEnvelopeV1[];
}

interface ComparableTool extends AgentToolDefinition {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createVoiceSurface(): VoiceSurfaceState {
  return {
    commentaryTexts: [],
    progress: null,
    taskDraft: null,
    widgets: [],
    removeWidgetIds: [],
    pluginProjections: [],
  };
}

function createHarnessTools(
  responseMode: ManagerAgentResponseMode,
  pluginContext?: HomerailPluginTurnContextV1,
  pluginToolTurnToken?: string,
  canvasContext?: GenerativeUiCanvasContextV1,
  managerSkills?: ManagerAgentPromptSkill[],
) {
  const hostState = {
    restUrl: "http://127.0.0.1:1/api",
    workspace: "/tmp/homerail-tool-parity",
    projectId: "project-parity",
    sessionId: "session-parity",
    createdRunIds: [] as string[],
    finalNotes: [] as string[],
    objectiveToolCalls: [] as Array<{ name: string; success: boolean; error?: string }>,
    voiceSurface: createVoiceSurface(),
  };
  const workerState = {
    projectId: "project-parity",
    sessionId: "session-parity",
    createdRunIds: [] as string[],
    finalNotes: [] as string[],
    objectiveToolCalls: [] as Array<{
      name: string;
      success: boolean;
      error?: string;
      inferred?: boolean;
    }>,
    voiceSurface: createVoiceSurface(),
  };

  return {
    hostState,
    workerState,
    hostTools: createHostCodexManagerTools(
      hostState,
      responseMode,
      pluginContext,
      pluginToolTurnToken,
      canvasContext,
      managerSkills,
    ) as ComparableTool[],
    workerTools: createWorkerManagerTools(
      workerState,
      responseMode,
      pluginContext,
      pluginToolTurnToken,
      canvasContext,
      managerSkills,
    ) as ComparableTool[],
  };
}

let previousHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  closeDb();
  previousHome = process.env.HOMERAIL_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-tool-parity-"));
  process.env.HOMERAIL_HOME = tmpHome;
  syncBuiltinPlugins();
});

afterEach(() => {
  closeDb();
  if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
  else process.env.HOMERAIL_HOME = previousHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function catalogProjection(tools: AgentToolDefinition[]): AgentToolDefinition[] {
  return tools
    .map(({ name, description, input_schema }) => ({ name, description, input_schema }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function expectUniqueNames(tools: AgentToolDefinition[]): void {
  const names = tools.map((tool) => tool.name);
  expect(new Set(names).size).toBe(names.length);
}

function requireTool(tools: ComparableTool[], name: string): ComparableTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing Manager Agent tool: ${name}`);
  return tool;
}

function visualManagerSkill(): ManagerAgentPromptSkill {
  return {
    id: "visual-skill",
    content: "Use the profile template for compact answers.",
    view_templates: [{
      id: "profile",
      description: "Show a compact entity profile.",
      data_schema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          value: { type: "number" },
        },
        required: ["title", "value"],
        additionalProperties: false,
      },
      a2ui: {
        version: "v1.0",
        catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
        components: [{
          id: "root",
          component: "HrMetric",
          label: { path: "/data/title" },
          value: { path: "/data/value" },
        }],
      },
      defaults: {
        surface: "result",
        importance: "primary",
        density: "summary",
        canvas_size: "1x1",
        persistence: "session",
      },
    }],
  };
}

describe.each<ManagerAgentResponseMode>(["chat", "voice"])(
  "Manager Agent %s tool catalog parity",
  (responseMode) => {
    it("keeps Host Codex and Worker definitions equal to the protocol catalog", () => {
      const { hostTools, workerTools } = createHarnessTools(responseMode);
      const protocolTools = managerAgentCommonToolCatalog(responseMode);

      expectUniqueNames(hostTools);
      expectUniqueNames(workerTools);
      expectUniqueNames(protocolTools);

      const expected = catalogProjection(protocolTools);
      expect(catalogProjection(hostTools)).toEqual(expected);
      expect(catalogProjection(workerTools)).toEqual(expected);
      expect(catalogProjection(hostTools)).toEqual(catalogProjection(workerTools));
    });
  },
);

describe("Manager Agent deterministic result envelope parity", () => {
  it("removes legacy Widget writers when the canonical Core Tool is bound", () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const { hostTools, workerTools } = createHarnessTools("voice", context, "bound-turn-token");
    const forbidden = [
      "show_status_card",
      "show_list_card",
      "show_progress_card",
      "show_note_card",
      "show_artifact_card",
      "show_dynamic_widget",
      "update_voice_surface",
      "remove_widget",
    ];
    for (const tools of [hostTools, workerTools]) {
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("update_task_draft");
      expect(names).toContain(context.tools.find(
        (tool) => tool.qualified_id === "com.homerail.core:upsert_generated_view",
      )!.wire_id);
      for (const name of forbidden) expect(names).not.toContain(name);
    }
    expect(catalogProjection(hostTools)).toEqual(catalogProjection(workerTools));
  });

  it("builds and executes the same validated Skill A2UI Tool in both voice harnesses", async () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const managerSkills = [visualManagerSkill()];
    const { hostTools, workerTools } = createHarnessTools(
      "voice",
      context,
      undefined,
      undefined,
      managerSkills,
    );
    const hostSkillTools = hostTools.filter((tool) => tool.name.startsWith("skill_view_"));
    const workerSkillTools = workerTools.filter((tool) => tool.name.startsWith("skill_view_"));
    expect(catalogProjection(hostSkillTools)).toEqual(catalogProjection(workerSkillTools));
    expect(hostSkillTools).toHaveLength(1);

    const input = { id: "profile-one", data: { title: "Profile", value: 4 } };
    expect(await hostSkillTools[0].handler(input)).toEqual(await workerSkillTools[0].handler(input));
  });

  it("rejects raw generated-view submissions already owned by a loaded Skill template", async () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const { hostTools, workerTools } = createHarnessTools(
      "voice",
      context,
      undefined,
      undefined,
      [visualManagerSkill()],
    );
    const generatedViewTool = context.tools.find(
      (tool) => tool.qualified_id === "com.homerail.core:upsert_generated_view",
    )!.wire_id;
    const rawInput = {
      id: "profile-one",
      content: { data: { title: "Profile", value: 4 } },
    };
    for (const tools of [hostTools, workerTools]) {
      await expect(requireTool(tools, generatedViewTool).handler(rawInput)).rejects.toThrow(
        /Use skill_view_visual-skill_profile_/,
      );
    }
  });

  it("keeps side-effect-free Host Codex and Worker handlers compatible", async () => {
    const { hostState, workerState, hostTools, workerTools } = createHarnessTools("voice");
    const fixtures = [
      {
        name: "finish",
        input: { text: "parity complete" },
        expected: { content: [{ type: "text", text: "finished" }] },
      },
      {
        name: "update_task_draft",
        input: { title: "Parity task", status: "draft" },
        expected: { content: [{ type: "text", text: "task draft updated" }] },
      },
      {
        name: "show_status_card",
        input: { id: "status-parity", title: "Parity", status: "ready" },
        expected: { content: [{ type: "text", text: "widget updated" }] },
      },
      {
        name: "show_dynamic_widget",
        input: { id: "dynamic-parity", type: "timeline", title: "Timeline" },
        expected: { content: [{ type: "text", text: "widget updated" }] },
      },
      {
        name: "remove_widget",
        input: { id: "status-parity" },
        expected: { content: [{ type: "text", text: "widget removed" }] },
      },
      {
        name: "update_voice_surface",
        input: {
          commentary_texts: ["checking parity"],
          progress: { status: "running", short_text: "checking" },
          remove_widget_ids: ["dynamic-parity"],
        },
        expected: { content: [{ type: "text", text: "voice surface updated" }] },
      },
    ] as const;

    for (const fixture of fixtures) {
      const hostResult = await requireTool(hostTools, fixture.name).handler(fixture.input);
      const workerResult = await requireTool(workerTools, fixture.name).handler(fixture.input);
      expect(hostResult).toEqual(fixture.expected);
      expect(workerResult).toEqual(fixture.expected);
      expect(hostResult).toEqual(workerResult);
    }

    expect(hostState.finalNotes).toEqual(workerState.finalNotes);
    expect(hostState.voiceSurface).toEqual(workerState.voiceSurface);
  });

  it("executes the same enabled plugin projection through both voice harnesses", async () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const descriptor = context.tools.find((tool) => tool.plugin_id === "com.homerail.topic-outline")!;
    const { hostState, workerState, hostTools, workerTools } = createHarnessTools("voice", context);
    const input = {
      id: "com.homerail.topic-outline:topic-parity",
      title: "Plugin pipeline",
      brief: "One vertical path from Skill to Renderer.",
      thesis: "The DSL is the ABI.",
      outline: [{ title: "Manifest", status: "ready", points: ["Declare the scene"] }],
      questions: ["How is disable handled?"],
      sources: [{ title: "Architecture", url: "https://example.com/architecture", note: "Local design baseline" }],
      next_action: "Validate the fallback",
    };
    const hostResult = await requireTool(hostTools, descriptor.wire_id).handler(input);
    const workerResult = await requireTool(workerTools, descriptor.wire_id).handler(input);
    expect(hostResult).toEqual(workerResult);
    expect(hostState.voiceSurface).toEqual(workerState.voiceSurface);
    expect(hostState.voiceSurface.pluginProjections).toHaveLength(1);
    expect(hostState.voiceSurface.pluginProjections[0]).toMatchObject({
      committed: false,
      plugin: { id: "com.homerail.topic-outline", version: "1.0.0" },
      projection: {
        node: {
          id: "com.homerail.topic-outline:topic-parity",
          kind: "com.homerail.topic-outline/outline",
          content: { title: "Plugin pipeline" },
          fallback: {
            items: expect.arrayContaining([
              "Thesis: The DSL is the ABI.",
              "Section: Manifest: Declare the scene",
              "Question: How is disable handled?",
              "Source: Architecture: Local design baseline",
            ]),
          },
        },
      },
    });
    expect(hostState.voiceSurface.widgets).toHaveLength(0);
    expect(hostState.voiceSurface.pluginProjections[0].projection.legacy_widget).toMatchObject({
      id: "com.homerail.topic-outline:topic-parity",
      type: "topic_outline",
    });
  });

  it("binds selected generated-view updates to the authoritative canvas id in both harnesses", async () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const canvasContext: GenerativeUiCanvasContextV1 = {
      canvas_context_version: 1,
      document_id: "document-parity",
      document_revision: 4,
      selected_node_id: "com.homerail.core:news-summary",
      nodes: [{
        id: "com.homerail.core:news-summary",
        revision: 4,
        kind: "com.homerail.core/generated_view",
        surface: "result",
        title: "News summary",
        selected: true,
        content: { data: { title: "News summary" } },
        a2ui: {
          version: "v1.0",
          catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
          components: [{ id: "root", component: "Text", text: { path: "/data/title" } }],
        },
      }],
    };
    const { hostState, workerState, hostTools, workerTools } = createHarnessTools(
      "voice",
      context,
      undefined,
      canvasContext,
    );
    const input = {
      title: "Updated news summary",
      summary: "The selected Block was updated in place.",
      surface: "result",
      importance: "primary",
      density: "summary",
      canvas_size: "1x2",
      persistence: "session",
      content: { data: { title: "Updated news summary" } },
    };
    for (const tools of [hostTools, workerTools]) {
      const selectedTool = requireTool(tools, "update_selected_generated_view");
      const properties = selectedTool.input_schema.properties as Record<string, unknown>;
      expect(properties.id).toBeUndefined();
      expect(properties.a2ui).toBeDefined();
      expect(properties.view).toBeUndefined();
      expect(selectedTool.input_schema.required).not.toContain("id");
      expect(selectedTool.input_schema.required).not.toContain("a2ui");
      await selectedTool.handler(input);
      const removed = await requireTool(tools, "remove_generated_view").handler({
        id: "com.homerail.core:news-summary",
      });
      expect(removed).toEqual({ content: [{ type: "text", text: "generated view queued for removal" }] });
      await expect(requireTool(tools, "remove_generated_view").handler({
        id: "com.homerail.core:not-in-context",
      })).rejects.toThrow(/not removable in the current canvas context/);
    }
    expect(hostState.voiceSurface).toEqual(workerState.voiceSurface);
    expect(hostState.voiceSurface.removeWidgetIds).toEqual(["com.homerail.core:news-summary"]);
    expect(hostState.voiceSurface.pluginProjections[0]).toMatchObject({
      projection: {
        node: {
          id: "com.homerail.core:news-summary",
          a2ui: {
            version: "v1.0",
            catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
            components: [{ id: "root", component: "Text" }],
          },
        },
      },
    });
  });

  it("never exposes voice-only plugin Tools in chat and rejects a tampered Context in both harnesses", () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    expect(createHarnessTools("chat", context).hostTools.some((tool) => tool.name === context.tools[0].wire_id)).toBe(false);
    const tampered = structuredClone(context);
    tampered.tools[0].description = "tampered";
    expect(() => createHostCodexManagerTools({
      restUrl: "http://127.0.0.1:1/api",
      workspace: "/tmp/homerail-tool-parity",
      createdRunIds: [],
      finalNotes: [],
      objectiveToolCalls: [],
      voiceSurface: createVoiceSurface(),
    }, "voice", tampered)).toThrow(/digest verification/);
    expect(() => createWorkerManagerTools({
      createdRunIds: [],
      finalNotes: [],
      objectiveToolCalls: [],
      voiceSurface: createVoiceSurface(),
    }, "voice", tampered)).toThrow(/digest verification/);
  });

  it("rejects plugin-owned scene writes through both Core widget entry points", async () => {
    const { hostTools, workerTools } = createHarnessTools(
      "voice",
      assemblePluginTurnContext(undefined, { modality: "voice" }),
    );
    for (const tools of [hostTools, workerTools]) {
      await expect(requireTool(tools, "show_dynamic_widget").handler({
        id: "topic-bypass",
        type: "topic_outline",
        title: "Bypass",
      })).rejects.toThrow(/enabled plugin Tool/);
      await expect(requireTool(tools, "update_voice_surface").handler({
        widgets: [{
          id: "topic-bypass-visual",
          type: "html",
          title: "Bypass",
          data: { visual: "topic_outline" },
        }],
      })).rejects.toThrow(/enabled plugin Tool/);
    }
  });
});

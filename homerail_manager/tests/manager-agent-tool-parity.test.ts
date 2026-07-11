import { describe, expect, it } from "vitest";

import {
  managerAgentCommonToolCatalog,
  type AgentToolDefinition,
  type ManagerAgentResponseMode,
} from "homerail-protocol";
import { createManagerTools as createHostCodexManagerTools } from "../src/server/host-codex-manager-agent.js";
import { createManagerTools as createWorkerManagerTools } from "../../homerail_worker/src/manager-agent/server.js";

interface VoiceSurfaceState {
  commentaryTexts: string[];
  progress: Record<string, unknown> | null;
  taskDraft: Record<string, unknown> | null;
  widgets: Record<string, unknown>[];
  removeWidgetIds: string[];
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
  };
}

function createHarnessTools(responseMode: ManagerAgentResponseMode) {
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
    hostTools: createHostCodexManagerTools(hostState, responseMode) as ComparableTool[],
    workerTools: createWorkerManagerTools(workerState, responseMode) as ComparableTool[],
  };
}

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
});

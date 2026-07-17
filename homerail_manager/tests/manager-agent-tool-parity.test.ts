import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOMERAIL_MANAGER_TURN_HEADER,
  managerAgentTurnScopeFromPayload,
  managerAgentCommonToolCatalog,
  managerAgentPluginToolCallName,
  type AgentToolDefinition,
  type GenerativeUiCanvasContextV1,
  type ManagerAgentResponseMode,
  type ManagerAgentPromptSkill,
  type ManagerAgentTurnEnvelopeV1,
  type HomerailPluginToolExecutionEnvelopeV1,
  type HomerailPluginTurnContextV1,
} from "homerail-protocol";
import { createManagerTools as createHostCodexManagerTools } from "../src/server/host-codex-manager-agent.js";
import {
  _withManagerTurnEnvelopeForTest,
  createManagerTools as createWorkerManagerTools,
} from "../../homerail_worker/src/manager-agent/server.js";
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
      const descriptor = context.tools.find(
        (tool) => tool.qualified_id === "com.homerail.core:upsert_generated_view",
      )!;
      expect(names).toContain(managerAgentPluginToolCallName(descriptor, context.tools));
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
    const generatedViewDescriptor = context.tools.find(
      (tool) => tool.qualified_id === "com.homerail.core:upsert_generated_view",
    )!;
    const generatedViewTool = managerAgentPluginToolCallName(generatedViewDescriptor, context.tools);
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

  it("maps DAG Actor intervention identically while preserving harness authentication", async () => {
    const { hostState, workerState, hostTools, workerTools } = createHarnessTools("chat");
    const restUrl = "https://manager.test/api";
    hostState.restUrl = restUrl;
    vi.stubEnv("MANAGER_REST_URL", restUrl);
    vi.stubEnv("HOMERAIL_MANAGER_ADMIN_TOKEN", "A".repeat(32));
    vi.stubEnv("HOMERAIL_DAG_MUTATION_TOKEN", "mutation-parity-token");

    const observed: Array<{
      method: string;
      pathname: string;
      body: Record<string, unknown>;
      authorization: string | null;
      managerTurn: string | null;
      mutationToken: string | null;
    }> = [];
    vi.stubGlobal("fetch", async (request: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string"
        ? JSON.parse(init.body) as Record<string, unknown>
        : {};
      observed.push({
        method: init?.method ?? "GET",
        pathname: new URL(rawUrl).pathname,
        body,
        authorization: headers.get("authorization"),
        managerTurn: headers.get(HOMERAIL_MANAGER_TURN_HEADER),
        mutationToken: headers.get("x-homerail-dag-token"),
      });
      const conflict = body.idempotency_key === "conflict-intervention";
      return new Response(JSON.stringify(conflict
        ? { success: false, error: "state token conflict" }
        : { success: true, data: { intervention_id: "intervention-parity" } }), {
        status: conflict ? 409 : 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const input = {
      run_id: "run /?# supervised",
      actor_id: "research /?#",
      operation: "checkpoint_fork",
      instruction: "Resume from the verified checkpoint with the corrected constraint.",
      expected_state_token: "opaque-state-token",
      idempotency_key: "intervention-parity-1",
      checkpoint_version: 3,
    };
    const workerPayload = {
      project_id: "project-parity",
      session_id: "session-parity",
      response_mode: "chat",
      manager_api_scopes: ["POST:/api/runs/*/actors/*/interventions"],
    };
    const workerTurn: ManagerAgentTurnEnvelopeV1 = {
      claims: {
        turn_envelope_version: 1,
        issuer: "homerail-manager",
        audience: "homerail-manager-agent-worker",
        key_id: "manager-parity-key",
        turn_id: "turn-parity",
        issued_at: "2026-07-15T00:00:00.000Z",
        expires_at: "2026-07-15T00:05:00.000Z",
        payload_digest: "a".repeat(64),
        scope: managerAgentTurnScopeFromPayload(workerPayload, {
          runtime_placement: "host_shell",
          worker_id: "worker-parity",
        }),
      },
      signature: "A".repeat(86),
    };

    const hostResult = await requireTool(hostTools, "intervene_dag_actor").handler(input);
    const workerResult = await _withManagerTurnEnvelopeForTest(
      workerTurn,
      () => requireTool(workerTools, "intervene_dag_actor").handler(input),
    );
    expect(hostResult).toEqual(workerResult);
    expect(observed.map(({ method, pathname, body }) => ({ method, pathname, body }))).toEqual([
      {
        method: "POST",
        pathname: "/api/runs/run%20%2F%3F%23%20supervised/actors/research%20%2F%3F%23/interventions",
        body: {
          operation: "checkpoint_fork",
          instruction: input.instruction,
          expected_state_token: "opaque-state-token",
          idempotency_key: "intervention-parity-1",
          checkpoint_version: 3,
        },
      },
      {
        method: "POST",
        pathname: "/api/runs/run%20%2F%3F%23%20supervised/actors/research%20%2F%3F%23/interventions",
        body: {
          operation: "checkpoint_fork",
          instruction: input.instruction,
          expected_state_token: "opaque-state-token",
          idempotency_key: "intervention-parity-1",
          checkpoint_version: 3,
        },
      },
    ]);
    expect(observed[0]).toMatchObject({
      authorization: `Bearer ${"A".repeat(32)}`,
      managerTurn: null,
      mutationToken: "mutation-parity-token",
    });
    expect(observed[1]).toMatchObject({
      authorization: null,
      managerTurn: Buffer.from(JSON.stringify(workerTurn), "utf8").toString("base64url"),
      mutationToken: "mutation-parity-token",
    });
    expect(hostState.objectiveToolCalls).toEqual([{ name: "intervene_dag_actor", success: true }]);
    expect(workerState.objectiveToolCalls).toEqual([{ name: "intervene_dag_actor", success: true }]);

    const conflictInput = { ...input, idempotency_key: "conflict-intervention" };
    const errors = await Promise.all([
      requireTool(hostTools, "intervene_dag_actor").handler(conflictInput)
        .then(() => "", (error: unknown) => error instanceof Error ? error.message : String(error)),
      _withManagerTurnEnvelopeForTest(
        workerTurn,
        () => requireTool(workerTools, "intervene_dag_actor").handler(conflictInput),
      ).then(() => "", (error: unknown) => error instanceof Error ? error.message : String(error)),
    ]);
    expect(errors[0]).toBe(errors[1]);
    expect(errors[0]).toContain("Manager API 409");
    expect(errors[0]).toContain("state token conflict");
  });

  it("rejects physical target and arbitrary intervention fields before either harness sends HTTP", async () => {
    const { hostTools, workerTools } = createHarnessTools("chat");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      run_id: "run-supervised",
      actor_id: "research",
      operation: "retry",
      expected_state_token: "opaque-state-token",
      idempotency_key: "intervention-parity-2",
    };
    const forbiddenFields = [
      "node_id",
      "worker_id",
      "container_id",
      "session_id",
      "lease_id",
      "lease_generation",
      "generation",
      "revision",
      "target_id",
      "target_generation",
      "unexpected",
    ];

    for (const tools of [hostTools, workerTools]) {
      for (const field of forbiddenFields) {
        await expect(requireTool(tools, "intervene_dag_actor").handler({
          ...input,
          [field]: "forbidden",
        })).rejects.toThrow(new RegExp(`additional properties: ${field}`));
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the legacy Host command mapping and submits a batch with one encoded POST", async () => {
    const { hostState, hostTools } = createHarnessTools("chat");
    hostState.restUrl = "https://manager.test/api";
    const observed: Array<{
      method: string;
      pathname: string;
      body: Record<string, unknown>;
    }> = [];
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      observed.push({
        method: init?.method ?? "GET",
        pathname: new URL(rawUrl).pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {},
      });
      const body = observed.at(-1)?.body ?? {};
      const commands = Array.isArray(body.commands)
        ? body.commands as Array<{ actor_id?: unknown }>
        : [];
      const call = observed.length;
      return new Response(JSON.stringify({
        success: true,
        data: {
          resumed: true,
          previous_round_id: String(body.expected_round_id),
          round_id: `round-resumed-${call}`,
          ordinal: call + 1,
          actor_ids: commands.map((command) => String(command.actor_id)),
          command_ids: commands.map((_, index) => `command-${call}-${index + 1}`),
          dispatched: commands.length,
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tool = requireTool(hostTools, "send_dag_actor_command");

    await tool.handler({
      run_id: "run /?# supervised",
      actor_id: "research",
      expected_round_id: "round-0001",
      idempotency_key: "command-research-2",
      payload: { task: "continue research" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tool.handler({
      run_id: "run /?# supervised",
      expected_round_id: "round-0002",
      commands: [
        { actor_id: "research", payload: { task: "continue research" } },
        { actor_id: "build", payload: { task: "continue build" } },
        { actor_id: "verify", payload: { task: "continue verification" } },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(observed).toEqual([
      {
        method: "POST",
        pathname: "/api/runs/run%20%2F%3F%23%20supervised/commands",
        body: {
          expected_round_id: "round-0001",
          commands: [{
            actor_id: "research",
            idempotency_key: "command-research-2",
            payload: { task: "continue research" },
          }],
        },
      },
      {
        method: "POST",
        pathname: "/api/runs/run%20%2F%3F%23%20supervised/commands",
        body: {
          expected_round_id: "round-0002",
          commands: [
            { actor_id: "research", payload: { task: "continue research" } },
            { actor_id: "build", payload: { task: "continue build" } },
            { actor_id: "verify", payload: { task: "continue verification" } },
          ],
        },
      },
    ]);
    expect(hostState.objectiveToolCalls).toEqual([
      { name: "send_dag_actor_command", success: true },
      { name: "send_dag_actor_command", success: true },
    ]);
  });

  it("rejects malformed Host command batches before HTTP and surfaces the batch API error", async () => {
    const { hostState, hostTools } = createHarnessTools("chat");
    hostState.restUrl = "https://manager.test/api";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      error: "waiting round conflict",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = requireTool(hostTools, "send_dag_actor_command");
    const base = {
      run_id: "run-supervised",
      expected_round_id: "round-0001",
    };
    const invalidInputs: Array<{ input: Record<string, unknown>; error: RegExp }> = [
      { input: { ...base, commands: [] }, error: /between 1 and 128 entries/ },
      {
        input: {
          ...base,
          commands: Array.from({ length: 129 }, (_, index) => ({ actor_id: `actor-${index}`, payload: index })),
        },
        error: /between 1 and 128 entries/,
      },
      {
        input: { ...base, commands: [{ actor_id: "research" }] },
        error: /commands\[0\]\.payload is required/,
      },
      {
        input: { ...base, commands: [{ actor_id: "research", payload: null, worker_id: "forbidden" }] },
        error: /additional properties: worker_id/,
      },
      {
        input: {
          ...base,
          commands: [
            { actor_id: "research", payload: 1 },
            { actor_id: " research ", payload: 2 },
          ],
        },
        error: /unique actor_id/,
      },
      {
        input: {
          ...base,
          actor_id: "research",
          idempotency_key: "legacy-key",
          payload: null,
          commands: [{ actor_id: "verify", payload: null }],
        },
        error: /not both/,
      },
      {
        input: { ...base, commands: [{ actor_id: "research", payload: null }], container_id: "forbidden" },
        error: /additional properties: container_id/,
      },
    ];

    for (const invalid of invalidInputs) {
      await expect(tool.handler(invalid.input)).rejects.toThrow(invalid.error);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(tool.handler({
      ...base,
      commands: [
        { actor_id: "research", payload: { task: "continue" } },
        { actor_id: "verify", payload: { task: "continue" } },
      ],
    })).rejects.toThrow(/Manager API 409.*waiting round conflict/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hostState.objectiveToolCalls).toEqual([{
      name: "send_dag_actor_command",
      success: false,
      error: expect.stringMatching(/Manager API 409.*waiting round conflict/),
    }]);
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
    const callName = managerAgentPluginToolCallName(descriptor, context.tools);
    const hostResult = await requireTool(hostTools, callName).handler(input);
    const workerResult = await requireTool(workerTools, callName).handler(input);
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

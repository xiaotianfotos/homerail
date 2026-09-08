import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOMERAIL_MANAGER_TURN_HEADER,
  HOMERAIL_UI_TOOL_NAMES,
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
import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { upsertDagWorkflowFromYaml, upsertDagRuntimeProfileFromYaml } from "../src/persistence/dag-workflows.js";
import { _clearActiveRuns } from "../src/runtime/active-runs.js";
import { closeDb } from "../src/persistence/db.js";
import { assemblePluginTurnContext } from "../src/plugins/context-assembler.js";
import { syncBuiltinPlugins } from "../src/plugins/registry.js";

interface VoiceSurfaceState {
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
  _clearActiveRuns();
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
    it("keeps Host Codex and Worker definitions equal to the route-scoped protocol catalog", () => {
      const { hostTools, workerTools } = createHarnessTools(responseMode);
      const protocolTools = managerAgentCommonToolCatalog(responseMode);

      expectUniqueNames(hostTools);
      expectUniqueNames(workerTools);
      expectUniqueNames(protocolTools);

      // Browser UI tools are capability-routed per turn and are deliberately
      // absent when this parity harness has no pinned renderer/Desktop route.
      const expected = catalogProjection(protocolTools.filter(
        (tool) => !(HOMERAIL_UI_TOOL_NAMES as readonly string[]).includes(tool.name),
      ));
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
    const hostSkillTools = hostTools.filter(
      (tool) => tool.name.startsWith("skill_view_")
        && tool.name !== "skill_view_render"
        && tool.name !== "skill_view_present",
    );
    const workerSkillTools = workerTools.filter(
      (tool) => tool.name.startsWith("skill_view_")
        && tool.name !== "skill_view_render"
        && tool.name !== "skill_view_present",
    );
    expect(catalogProjection(hostSkillTools)).toEqual(catalogProjection(workerSkillTools));
    expect(hostSkillTools).toHaveLength(1);

    const input = { id: "profile-one", data: { title: "Profile", value: 4 } };
    expect(await hostSkillTools[0].handler(input)).toEqual(await workerSkillTools[0].handler(input));
  });

  it("materializes and executes a native Skill template identically in both harnesses", async () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const { hostState, hostTools, workerTools } = createHarnessTools("voice", context);
    hostState.restUrl = "https://manager.test/api";
    vi.stubEnv("MANAGER_REST_URL", "https://manager.test/api");
    const observed: Array<{ pathname: string; body: Record<string, unknown> }> = [];
    const materialized = {
      id: "route-one",
      title: "Verified route",
      surface: "result",
      importance: "primary",
      density: "summary",
      canvas_size: "1x2",
      persistence: "session",
      content: { data: { title: "Verified route", steps: ["start", "finish"] } },
      a2ui: {
        version: "v1.0",
        catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
        components: [{ id: "root", component: "Text", text: { path: "/data/title" } }],
      },
    };
    vi.stubGlobal("fetch", async (request: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      observed.push({
        pathname: new URL(rawUrl).pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {},
      });
      return new Response(JSON.stringify({
        success: true,
        data: { input: materialized, response_text: "Route ready." },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const input = {
      skill_id: "route skill /?#",
      template_id: "route /?#",
      id: "route-one",
      data: { title: "Verified route", steps: ["start", "finish"] },
      canvas_size: "1x2",
    };
    const hostResult = await requireTool(hostTools, "skill_view_render").handler(input);
    const workerResult = await requireTool(workerTools, "skill_view_render").handler(input);
    expect(hostResult).toEqual(workerResult);
    const presenterInput = {
      skill_id: "route skill /?#",
      argv: ["present", "route", "start", "finish"],
    };
    const hostPresented = await requireTool(hostTools, "skill_view_present").handler(presenterInput);
    const workerPresented = await requireTool(workerTools, "skill_view_present").handler(presenterInput);
    expect(hostPresented).toEqual(workerPresented);
    expect(JSON.parse(hostPresented.content[0]?.text || "{}") as Record<string, unknown>).toMatchObject({
      status: "projected",
      committed: false,
      response_text: "Route ready.",
    });
    expect(observed).toEqual([
      {
        pathname: "/api/skills/route%20skill%20%2F%3F%23/views/route%20%2F%3F%23/materialize",
        body: { id: "route-one", data: input.data, canvas_size: "1x2" },
      },
      {
        pathname: "/api/skills/route%20skill%20%2F%3F%23/views/route%20%2F%3F%23/materialize",
        body: { id: "route-one", data: input.data, canvas_size: "1x2" },
      },
      {
        pathname: "/api/skills/route%20skill%20%2F%3F%23/views/present",
        body: { argv: presenterInput.argv },
      },
      {
        pathname: "/api/skills/route%20skill%20%2F%3F%23/views/present",
        body: { argv: presenterInput.argv },
      },
    ]);
  });

  it("starts a Skill-owned supervised DAG in the same presenter Tool call", async () => {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const { hostState, workerState, hostTools, workerTools } = createHarnessTools("voice", context);
    hostState.restUrl = "https://manager.test/api";
    vi.stubEnv("MANAGER_REST_URL", "https://manager.test/api");
    const observed: Array<{ pathname: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (request: string | URL | Request, init?: RequestInit) => {
      const rawUrl = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      const pathname = new URL(rawUrl).pathname;
      observed.push({
        pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {},
      });
      const data = pathname.endsWith("/views/present")
        ? {
            mode: "supervised_dag",
            launch: {
              workflow_id: "three-worker",
              profile: "local-model",
              prompt: "verified evidence",
              workflow_revision: 3,
              canonical_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              profile_updated_at: "2026-07-18T00:00:00.000Z",
            },
            response_text: "Three panels are updating.",
          }
        : { run_id: "run-three", dispatched: 3 };
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const input = { skill_id: "route-skill", argv: ["present", "copilot"] };
    const hostResult = await requireTool(hostTools, "skill_view_present").handler(input);
    const workerPayload = {
      project_id: "project-parity",
      session_id: "session-parity",
      response_mode: "voice" as const,
      manager_api_scopes: [
        "POST:/api/skills/*/views/present",
        "POST:/api/runs/create-and-run",
      ],
    };
    const workerTurn: ManagerAgentTurnEnvelopeV1 = {
      claims: {
        turn_envelope_version: 1,
        issuer: "homerail-manager",
        audience: "homerail-manager-agent-worker",
        key_id: "manager-parity-key",
        turn_id: "turn-skill-dag",
        issued_at: "2026-07-15T00:00:00.000Z",
        expires_at: "2026-07-15T00:05:00.000Z",
        payload_digest: "b".repeat(64),
        scope: managerAgentTurnScopeFromPayload(workerPayload, {
          runtime_placement: "host_shell",
          worker_id: "worker-parity",
        }),
      },
      signature: "B".repeat(86),
    };
    const workerResult = await _withManagerTurnEnvelopeForTest(
      workerTurn,
      () => requireTool(workerTools, "skill_view_present").handler(input),
    );
    expect(hostResult).toEqual(workerResult);
    expect(JSON.parse(hostResult.content[0]?.text || "{}") as Record<string, unknown>).toEqual({
      mode: "supervised_dag",
      run_id: "run-three",
      workflow_id: "three-worker",
      workflow_revision: 3,
      canonical_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      profile: "local-model",
      response_text: "Three panels are updating.",
    });
    expect(observed.map((entry) => entry.pathname)).toEqual([
      "/api/skills/route-skill/views/present",
      "/api/runs/create-and-run",
      "/api/skills/route-skill/views/present",
      "/api/runs/create-and-run",
    ]);
    const launchBodies = observed.filter((entry) => entry.pathname.endsWith("/create-and-run")).map((entry) => entry.body);
    expect(launchBodies).toHaveLength(2);
    expect(launchBodies[0].runId).not.toBe(launchBodies[1].runId);
    expect({ ...launchBodies[0], runId: undefined }).toEqual({ ...launchBodies[1], runId: undefined });
    expect(launchBodies[0]).toMatchObject({
      workflow_id: "three-worker",
      workflow_revision: 3,
      canonical_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      profile: "local-model",
      profile_updated_at: "2026-07-18T00:00:00.000Z",
      prompt: "verified evidence",
      runId: expect.stringMatching(/^skill_[a-f0-9]{32}$/),
    });
    expect(hostState.createdRunIds).toEqual(["run-three"]);
    expect(workerState.createdRunIds).toEqual(["run-three"]);
    expect(hostState.objectiveToolCalls).toEqual([
      { name: "skill_view_present", success: true },
      { name: "start_supervised_dag", success: true },
    ]);
    expect(workerState.objectiveToolCalls).toEqual([
      { name: "skill_view_present", success: true },
      { name: "start_supervised_dag", success: true },
    ]);
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


// Judger-owned regression oracles for PR #272. Exercise both actual client tools,
// real profile upserts and the real run lifecycle; only the HTTP boundary is local.
describe.each(["host", "worker"] as const)("%s skill launch occurrence and recovery", (harness) => {
  function setupLaunch() {
    const context = assemblePluginTurnContext(undefined, { modality: "voice" });
    const tools = createHarnessTools("voice", context);
    tools.hostState.restUrl = "https://manager.test/api";
    vi.stubEnv("MANAGER_REST_URL", "https://manager.test/api");
    return {
      tool: requireTool(harness === "host" ? tools.hostTools : tools.workerTools, "skill_view_present"),
      state: harness === "host" ? tools.hostState : tools.workerState,
      input: { skill_id: "review-regression", argv: ["present", "same"] },
    };
  }

  it("launches a fresh run for each presentation after real profile timestamp churn", async () => {
    const { tool, state, input } = setupLaunch();
    const workflow = upsertDagWorkflowFromYaml({ yaml_text: `
api_version: homerail.ai/v1
kind: Workflow
metadata: { id: skill-review-regression, name: Skill repeat }
spec:
  contracts:
    Text: { type: string }
  agents:
    worker: { system: Return a short result. }
  nodes:
    execute:
      kind: agent
      agent: worker
      allowed_dag_tools: [handoff]
      inputs: { task: { contract: Text } }
      outputs: { result: { contract: Text } }
    terminal:
      kind: terminal
      outcome: success
      inputs: { result: { contract: Text } }
  edges:
    - { from: $run.input, to: execute.task }
    - { from: execute.result, to: terminal.result }
` }).workflow;
    const dispatch = vi.fn(() => ({ status: "dispatched" as const, targetType: "fake", targetId: "fake" }));
    const orchestrator = new ChangeOrchestrator(new GraphExecutor({ dispatch }));
    const posts: Record<string, unknown>[] = [];
    const statuses: string[] = [];
    const pins: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      let data: unknown;
      if (pathname.endsWith("/views/present")) {
        // Ensure a real, distinct wall-clock timestamp without replacing nowIso.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const profile = upsertDagRuntimeProfileFromYaml({
          workflow_id: workflow.workflow_id,
          yaml_text: "profile_id: deterministic\ndefault: { agent_type: deterministic }\n",
        }).profile;
        pins.push(profile.updated_at);
        data = { mode: "supervised_dag", launch: {
          workflow_id: workflow.workflow_id, profile: profile.profile_id,
          prompt: "same presenter input", workflow_revision: workflow.head_revision,
          canonical_hash: workflow.canonical_hash, profile_updated_at: profile.updated_at,
        } };
      } else if (pathname.endsWith("/create-and-run")) {
        const body = JSON.parse(String(init?.body));
        posts.push(body);
        try {
          const run = orchestrator.createAndRun({
            runId: body.runId, workflowId: body.workflow_id, prompt: body.prompt,
            profile: body.profile, expectedWorkflowRevision: body.workflow_revision,
            expectedCanonicalHash: body.canonical_hash, expectedProfileUpdatedAt: body.profile_updated_at,
          });
          data = { run_id: run.runId, dispatched: run.dispatched };
        } catch (error) {
          return new Response(JSON.stringify({ code: "RUN_CREATION_CONFLICT", message: String(error) }), { status: 409 });
        }
      } else {
        statuses.push(pathname);
        data = { status: "active" }; // Old implementation falsely accepted this.
      }
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    });
    await tool.handler(input);
    await tool.handler(input);
    expect(pins[0]).not.toBe(pins[1]);
    expect(posts).toHaveLength(2);
    expect(posts[0].runId).not.toBe(posts[1].runId);
    expect(state.createdRunIds).toEqual(posts.map((post) => post.runId));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([]);
  });

  it.each([409, 403])("surfaces HTTP %i without status-only false success or retry", async (status) => {
    const { tool, state, input } = setupLaunch();
    const observed: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const pathname = new URL(url).pathname;
      observed.push(pathname);
      if (pathname.endsWith("/views/present")) return new Response(JSON.stringify({ data: {
        mode: "supervised_dag", launch: { workflow_id: "skill-repeat", prompt: "new prompt", workflow_revision: 1, canonical_hash: "a".repeat(64) },
      } }));
      if (pathname.endsWith("/create-and-run")) return new Response(JSON.stringify({ code: "RUN_CREATION_CONFLICT" }), { status });
      return new Response(JSON.stringify({ data: { status: "completed" } }));
    });
    await expect(tool.handler(input)).rejects.toThrow(`Manager API ${status}`);
    expect(observed).toEqual(["/api/skills/review-regression/views/present", "/api/runs/create-and-run"]);
    expect(state.createdRunIds).toEqual([]);
    expect(state.objectiveToolCalls).toEqual([]);
  });

  it("retries a lost acknowledgement with identical POST bytes and a verified creation receipt", async () => {
    const { tool, state, input } = setupLaunch();
    const posts: string[] = [];
    const paths: string[] = [];
    const launch = { workflow_id: "skill-repeat", prompt: "pinned prompt", profile: "local",
      workflow_revision: 7, canonical_hash: "a".repeat(64), profile_updated_at: "2026-09-08T00:00:00.000Z" };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname.endsWith("/views/present")) return new Response(JSON.stringify({ data: { mode: "supervised_dag", launch } }));
      if (pathname.endsWith("/create-and-run")) {
        posts.push(String(init?.body));
        if (posts.length === 1) throw new TypeError("connection reset after Manager commit");
        return new Response(JSON.stringify({ data: { run_id: JSON.parse(posts[0]).runId, dispatched: 0 } }));
      }
      throw new Error("Status existence cannot prove request identity");
    });
    await tool.handler(input);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toBe(posts[0]);
    expect(JSON.parse(posts[0])).toMatchObject(launch);
    expect(state.createdRunIds).toEqual([JSON.parse(posts[0]).runId]);
    expect(paths).toEqual(["/api/skills/review-regression/views/present", "/api/runs/create-and-run", "/api/runs/create-and-run"]);
  });
});

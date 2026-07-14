import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGER_AGENT_HARNESS,
  MANAGER_AGENT_PRODUCTION_RUNTIME_AGENT_TYPES,
  ManagerAgentRuntimePlacement,
  isDisabledDirectLlmAgentType,
  isManagerAgentHarness,
  managerAgentHarnessDefinition,
  managerAgentRuntimeAgentTypeForHarness,
  managerAgentRuntimePlacementForHarness,
  normalizeManagerAgentHarness,
  normalizeManagerAgentRuntimeAgentType,
} from "../src/manager-agent.js";
import { buildManagerAgentSystemPrompt } from "../src/manager-agent-prompt.js";
import {
  MANAGER_AGENT_COMMON_VOICE_TOOL_NAMES,
  MANAGER_AGENT_HOST_VOICE_TOOL_NAMES,
  MANAGER_AGENT_WIDGET_FILE_TYPES,
  formatHomeRailPromptHandoff,
  formatHomeRailPromptToolCall,
  managerAgentCommonToolCatalog,
  managerAgentToolSpec,
  parseHomeRailPromptHandoff,
  parseHomeRailPromptToolCalls,
  stripHomeRailPromptMarkers,
} from "../src/manager-agent-tools.js";
import {
  createManagerAgentWidgetFileTools,
  MANAGER_AGENT_WIDGET_FILE_TOOL_NAMES,
  type ManagerAgentWidgetFileToolAdapter,
} from "../src/manager-agent-widget-tools.js";

describe("Manager Agent harness contract", () => {
  it("keeps canonical public harness ids explicit", () => {
    expect(DEFAULT_MANAGER_AGENT_HARNESS).toBe("claude_agent_sdk");
    expect(isManagerAgentHarness("claude_agent_sdk")).toBe(true);
    expect(isManagerAgentHarness("codex_appserver")).toBe(true);
    expect(isManagerAgentHarness("kimi_code")).toBe(true);
    expect(isManagerAgentHarness("claude-sdk")).toBe(false);
    expect(isManagerAgentHarness("direct-llm")).toBe(false);
    expect(isManagerAgentHarness("unknown")).toBe(false);
  });

  it("normalizes legacy aliases in one shared place", () => {
    expect(normalizeManagerAgentHarness("claude")).toBe("claude_agent_sdk");
    expect(normalizeManagerAgentHarness("claude-sdk")).toBe("claude_agent_sdk");
    expect(normalizeManagerAgentHarness("claude-agent-sdk")).toBe("claude_agent_sdk");
    expect(normalizeManagerAgentHarness("codex")).toBe("codex_appserver");
    expect(normalizeManagerAgentHarness("codex-appserver")).toBe("codex_appserver");
    expect(normalizeManagerAgentHarness("kimi")).toBe("kimi_code");
    expect(normalizeManagerAgentHarness("kimi-code")).toBe("kimi_code");
    expect(normalizeManagerAgentHarness("unknown")).toBeUndefined();
  });

  it("declares the only Manager Agent runtime placement boundary", () => {
    expect(Object.values(ManagerAgentRuntimePlacement)).toEqual(["host", "host_shell", "container"]);
    expect(managerAgentRuntimePlacementForHarness("codex_appserver")).toBe("host");
    expect(managerAgentRuntimePlacementForHarness("kimi_code")).toBe("container");
    expect(managerAgentRuntimePlacementForHarness("claude_agent_sdk")).toBe("container");
  });

  it("maps public harness ids to runtime agent types", () => {
    expect(managerAgentRuntimeAgentTypeForHarness("codex_appserver")).toBe("codex_appserver");
    expect(managerAgentRuntimeAgentTypeForHarness("kimi_code")).toBe("kimi_code");
    expect(managerAgentRuntimeAgentTypeForHarness("claude_agent_sdk")).toBe("claude-sdk");
    expect(MANAGER_AGENT_PRODUCTION_RUNTIME_AGENT_TYPES).toEqual([
      "codex_appserver",
      "kimi_code",
      "claude-sdk",
    ]);
    expect(managerAgentHarnessDefinition("codex_appserver")).toMatchObject({
      harness: "codex_appserver",
      agent_type: "codex_appserver",
      runtime_placement: "host",
    });
  });

  it("normalizes runtime agent_type aliases while preserving unknown custom backends", () => {
    expect(normalizeManagerAgentRuntimeAgentType("claude-agent-sdk")).toBe("claude-sdk");
    expect(normalizeManagerAgentRuntimeAgentType("kimi-code")).toBe("kimi_code");
    expect(normalizeManagerAgentRuntimeAgentType("codex")).toBe("codex_appserver");
    expect(normalizeManagerAgentRuntimeAgentType("fixture-kimi-code")).toBe("fixture-kimi-code");
    expect(normalizeManagerAgentRuntimeAgentType("")).toBeUndefined();
  });

  it("keeps direct-llm disabled outside the public harness set", () => {
    expect(isDisabledDirectLlmAgentType("direct-llm")).toBe(true);
    expect(isDisabledDirectLlmAgentType("direct_llm")).toBe(true);
    expect(normalizeManagerAgentHarness("direct-llm")).toBeUndefined();
  });

  it("declares shared Manager Agent tool schemas separately from host-only helpers", () => {
    expect(MANAGER_AGENT_WIDGET_FILE_TYPES).toEqual([
      "memo",
      "task_draft",
      "progress_status",
      "checklist",
      "artifact_ref",
      "timeline",
    ]);
    expect(MANAGER_AGENT_COMMON_VOICE_TOOL_NAMES).toContain("update_voice_memo");
    expect(MANAGER_AGENT_COMMON_VOICE_TOOL_NAMES).toContain("write_widget_file");
    expect(MANAGER_AGENT_HOST_VOICE_TOOL_NAMES).toEqual([]);

    const chatNames = managerAgentCommonToolCatalog("chat").map((tool) => tool.name);
    const voiceNames = managerAgentCommonToolCatalog("voice").map((tool) => tool.name);
    expect(chatNames).toContain("create_and_run");
    expect(chatNames).toEqual(expect.arrayContaining([
      "list_skills",
      "read_skill",
      "list_dag_patterns",
      "get_dag_pattern",
      "instantiate_dag_pattern",
      "list_dag_approvals",
      "list_dag_triggers",
      "fire_dag_event",
      "get_dag_state",
      "set_dag_state",
      "get_dag_schema",
      "validate_dag_workflow",
      "sync_dag_workflow",
    ]));
    expect(chatNames).not.toContain("decide_dag_approval");
    expect(chatNames).not.toContain("write_widget_file");
    expect(voiceNames).toContain("write_widget_file");
    expect(voiceNames).toContain("update_voice_memo");
    expect(managerAgentToolSpec("create_and_run").input_schema.properties).toMatchObject({
      yamlPath: { type: "string" },
      workflow_id: { type: "string" },
      workflowId: { type: "string" },
      profile: { type: "string" },
    });
    expect(managerAgentToolSpec("create_and_run").input_schema.anyOf).toEqual([
      { required: ["workflow_id"] },
      { required: ["workflowId"] },
      { required: ["yamlPath"] },
    ]);
    expect(managerAgentToolSpec("instantiate_dag_pattern").input_schema.properties).toMatchObject({
      pattern_id: { type: "string" },
      parameters: { type: "object", additionalProperties: true },
      sync: { type: "boolean" },
    });
    expect(managerAgentToolSpec("validate_dag_workflow").input_schema.properties).toMatchObject({
      source: { type: "string", maxLength: 262144 },
    });
    expect(managerAgentToolSpec("write_widget_file").input_schema.properties).toMatchObject({
      widget_type: { type: "string", enum: MANAGER_AGENT_WIDGET_FILE_TYPES },
    });
  });

  it("builds shared handlers for all widget-file tools with adapter-backed side effects", async () => {
    const calls: string[] = [];
    const adapter: ManagerAgentWidgetFileToolAdapter = {
      async updateVoiceMemo() {
        calls.push("update_voice_memo");
        return { text: "memo", widget: { id: "voice-memo", type: "list" } };
      },
      async validateWidgetFile() {
        calls.push("validate_widget_file");
        return { text: "{\"ok\":true}" };
      },
      async writeWidgetFile() {
        calls.push("write_widget_file");
        return { text: "{\"ok\":true}", widget: { id: "written", type: "list" } };
      },
      async readWidgetFile() {
        calls.push("read_widget_file");
        return { text: "{\"ok\":true,\"widget_id\":\"written\"}" };
      },
      async removeWidgetFile() {
        calls.push("remove_widget_file");
        return { text: "{\"ok\":true}", removeWidgetId: "written" };
      },
      async showWidgetTomlExample() {
        calls.push("show_widget_toml_example");
        return { text: "widget_id = \"example\"" };
      },
    };
    const widgets: Record<string, unknown>[] = [];
    const removed: string[] = [];
    const tools = createManagerAgentWidgetFileTools({
      adapter,
      context: { projectId: "project-1", sessionId: "session-1" },
      voiceSurface: {
        addWidget: (widget) => widgets.push(widget),
        removeWidget: (id) => removed.push(id),
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([...MANAGER_AGENT_WIDGET_FILE_TOOL_NAMES]);
    for (const tool of tools) {
      await tool.handler({
        widget_type: "checklist",
        widget_id: "written",
        toml: "widget_id = \"written\"",
      });
    }

    expect(calls).toEqual([...MANAGER_AGENT_WIDGET_FILE_TOOL_NAMES]);
    expect(widgets).toEqual([
      { id: "voice-memo", type: "list" },
      { id: "written", type: "list" },
    ]);
    expect(removed).toEqual(["written"]);
  });

  it("builds one voice prompt contract for host and container harnesses", () => {
    const prompt = buildManagerAgentSystemPrompt({
      responseMode: "voice",
      runtime: { placement: "container", provider: "kimi", model: "kimi-code" },
      voiceSystem: { source: "system:test", prompt: "VOICE_SYSTEM" },
      voiceUiRules: { sources: ["user:test"], hash: "abc123", prompt: "VOICE_RULES" },
    });
    expect(prompt).toContain("manager-agent container");
    expect(prompt).toContain("VOICE_SYSTEM");
    expect(prompt).toContain("Voice UI rules hash: abc123");
    expect(prompt).toContain("VOICE_RULES");
    expect(prompt).toContain("Use tool-created widgets for generated UI");
    expect(prompt).toContain("Commentary is spoken too");
    expect(prompt).toContain("never narrate Skill loading, tool names, read-only checks, rendering, or canvas updates");
  });

  it("renders HomeRail skill metadata and the pattern-first DAG workflow", () => {
    const prompt = buildManagerAgentSystemPrompt({
      runtime: { placement: "host", provider: "codex", model: "gpt-5.5" },
      skills: [
        {
          id: "homerail-dag-patterns",
          description: "Select and instantiate reusable DAG patterns.",
          source: "home",
        },
        {
          id: "custom-operator",
          description: "Apply local operations policy.",
          source: "home",
        },
      ],
    });

    expect(prompt).toContain("Available HomeRail Skills");
    expect(prompt).toContain("homerail-dag-patterns: Select and instantiate reusable DAG patterns. [home]");
    expect(prompt).toContain("custom-operator: Apply local operations policy. [home]");
    expect(prompt).toContain("call read_skill before acting");
    expect(prompt).toContain("instantiate_dag_pattern and create_and_run");
  });

  it("embeds already-selected Skill bodies without asking the Agent to reload them", () => {
    const prompt = buildManagerAgentSystemPrompt({
      skills: [{
        id: "com.homerail.core:voice-generative-ui",
        description: "Build structured voice UI.",
        source: "plugin",
        content: "Use the bound Core Tool once and require a committed result.",
      }],
    });

    expect(prompt).toContain("com.homerail.core:voice-generative-ui: Build structured voice UI. [plugin] [already loaded]");
    expect(prompt).toContain("## Loaded HomeRail Skill: com.homerail.core:voice-generative-ui");
    expect(prompt).toContain("Use the bound Core Tool once and require a committed result.");
    expect(prompt).toContain("do not call read_skill again");
  });

  it("advertises validated Skill visual templates without embedding a model-authored layout", () => {
    const prompt = buildManagerAgentSystemPrompt({
      responseMode: "voice",
      skills: [{
        id: "palquery",
        description: "Query Palworld data.",
        source: "home",
        content: "Use verified query results.",
        view_templates: [{
          id: "pal-profile",
          description: "Compact profile with a real icon.",
          data_schema: {
            type: "object",
            properties: { title: { type: "string", maxLength: 200 } },
            required: ["title"],
            additionalProperties: false,
          },
          a2ui: {
            version: "v1.0",
            catalogId: "https://homerail.dev/a2ui/catalogs/core/v1",
            components: [{ id: "root", component: "Text", text: { path: "/data/title" } }],
          },
          defaults: {
            surface: "result",
            importance: "primary",
            density: "summary",
            canvas_size: "1x1",
            persistence: "session",
          },
        }],
      }],
    });

    expect(prompt).toContain("Validated Skill visual templates are available as skill_view_* Tools");
    expect(prompt).toContain("pal-profile: Compact profile with a real icon.");
  });

  it("describes host-shell manager agents separately from containers", () => {
    const prompt = buildManagerAgentSystemPrompt({
      runtime: { placement: "host_shell", provider: "kimi", model: "kimi-k2.7" },
    });
    expect(prompt).toContain("manager-agent host shell process");
    expect(prompt).not.toContain("manager-agent container");
  });

  it("parses HomeRail prompt-mode tool markers as shared protocol data", () => {
    const create = formatHomeRailPromptToolCall({
      name: "create_and_run",
      input: { yamlPath: "assets/orchestrations/public-two-node.yaml.template" },
    });
    const finish = formatHomeRailPromptToolCall({
      name: "finish",
      input: { text: "done" },
    });
    const handoff = formatHomeRailPromptHandoff({
      port: "done",
      content: { ok: true },
      summary: "ok",
    });
    const text = [
      "before",
      create.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      finish,
      handoff,
      "after",
    ].join("\n");

    expect(parseHomeRailPromptToolCalls(text)).toEqual([
      {
        name: "create_and_run",
        input: { yamlPath: "assets/orchestrations/public-two-node.yaml.template" },
      },
      {
        name: "finish",
        input: { text: "done" },
      },
    ]);
    expect(parseHomeRailPromptHandoff(text)).toEqual({
      port: "done",
      content: { ok: true },
      summary: "ok",
    });
    expect(stripHomeRailPromptMarkers(text)).toBe("before\n\n\n\nafter");
  });
});

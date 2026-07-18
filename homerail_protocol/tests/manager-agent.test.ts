import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGER_AGENT_HARNESS,
  MANAGER_AGENT_PRODUCTION_RUNTIME_AGENT_TYPES,
  ManagerAgentRuntimePlacement,
  isDisabledDirectLlmAgentType,
  isKimiCodeCompatibleModelSetting,
  isManagerAgentHarness,
  managerAgentHarnessDefinition,
  managerAgentRuntimeAgentTypeForHarness,
  managerAgentRuntimePlacementForHarness,
  normalizeManagerAgentHarness,
  normalizeManagerAgentRuntimeAgentType,
} from "../src/manager-agent.js";
import {
  buildManagerAgentSystemPrompt,
  managerAgentDagContextPrompt,
  normalizeManagerAgentDagContext,
} from "../src/manager-agent-prompt.js";
import {
  MANAGER_AGENT_COMMON_TOOL_NAMES,
  MANAGER_AGENT_COMMON_VOICE_TOOL_NAMES,
  MANAGER_AGENT_DAG_ACTOR_INTERVENTION_OPERATIONS,
  MANAGER_AGENT_HOST_VOICE_TOOL_NAMES,
  MANAGER_AGENT_WIDGET_FILE_TYPES,
  canonicalManagerAgentToolCallName,
  formatHomeRailPromptHandoff,
  formatHomeRailPromptToolCall,
  managerAgentDagCommandResult,
  managerAgentCommonToolCatalog,
  managerAgentOutcomeObjectivePrompt,
  managerAgentPluginToolCallName,
  managerAgentRequiredToolObjectivePrompt,
  managerAgentToolSpec,
  normalizeManagerAgentDagActorCommandInput,
  normalizeManagerAgentDagActorInterventionInput,
  normalizeManagerAgentOutcomeCapabilities,
  normalizeManagerAgentRequiredToolCalls,
  parseHomeRailPromptHandoff,
  parseHomeRailPromptToolCalls,
  stripHomeRailPromptMarkers,
} from "../src/manager-agent-tools.js";
import {
  createManagerAgentWidgetFileTools,
  MANAGER_AGENT_WIDGET_FILE_TOOL_NAMES,
  type ManagerAgentWidgetFileToolAdapter,
} from "../src/manager-agent-widget-tools.js";

describe("Manager Agent required tool objective", () => {
  it("normalizes harness-specific MCP transport names at the public boundary", () => {
    expect(canonicalManagerAgentToolCallName("start_supervised_dag")).toBe("start_supervised_dag");
    expect(canonicalManagerAgentToolCallName("mcp__dag-tools__start_supervised_dag"))
      .toBe("start_supervised_dag");
    expect(canonicalManagerAgentToolCallName("mcp__plugin_server__qualified_tool"))
      .toBe("qualified_tool");
    expect(canonicalManagerAgentToolCallName("mcp__malformed")).toBe("mcp__malformed");
    expect(canonicalManagerAgentToolCallName(null)).toBe("");
  });

  it("normalizes and renders only an explicit generic runtime objective", () => {
    expect(normalizeManagerAgentRequiredToolCalls([
      " start_supervised_dag ",
      "focus_dag_actor",
      "mcp__dag-tools__focus_dag_actor",
      "start_supervised_dag",
      "",
      null,
    ])).toEqual(["start_supervised_dag", "focus_dag_actor"]);

    const prompt = managerAgentRequiredToolObjectivePrompt([
      "start_supervised_dag",
      "focus_dag_actor",
    ]);
    expect(prompt).toContain("start_supervised_dag, focus_dag_actor");
    expect(prompt).toContain("runtime verifies successful tool completion");
    expect(prompt).not.toMatch(/game|showcase|three-worker/i);
    expect(managerAgentRequiredToolObjectivePrompt(undefined)).toBe("");
  });
});

describe("Manager Agent stable outcome contract", () => {
  it("normalizes capabilities and renders an any-of Tool objective", () => {
    expect(normalizeManagerAgentOutcomeCapabilities([
      "canvas.view.committed",
      "canvas.view.committed",
      "artifact.published",
      "unknown",
    ])).toEqual(["canvas.view.committed", "artifact.published"]);
    const prompt = managerAgentOutcomeObjectivePrompt([{
      capability: "canvas.view.committed",
      tool_names: ["upsert_generated_view", "skill_view_route"],
    }]);
    expect(prompt).toContain("one of [upsert_generated_view, skill_view_route]");
    expect(prompt).toContain("filesystem-only output does not satisfy");
  });

  it("exposes a readable unique plugin alias while retaining wire ids for collisions", () => {
    const unique = { local_id: "upsert_generated_view", wire_id: "p_123_upsert_generated_view" };
    expect(managerAgentPluginToolCallName(unique, [unique])).toBe("upsert_generated_view");
    const duplicate = { local_id: "upsert_generated_view", wire_id: "p_456_upsert_generated_view" };
    expect(managerAgentPluginToolCallName(unique, [unique, duplicate])).toBe(unique.wire_id);
    const reserved = { local_id: "finish", wire_id: "p_123_finish" };
    expect(managerAgentPluginToolCallName(reserved, [reserved])).toBe(reserved.wire_id);
  });
});

describe("Manager Agent DAG context", () => {
  it("renders a bounded trusted current-run hint for Actor follow-ups", () => {
    const context = normalizeManagerAgentDagContext({
      context_version: 1,
      current_run_id: "run-current",
      attached_run_ids: [
        ...Array.from({ length: 20 }, (_, index) => `run-${index + 1}`),
        "run-current",
      ],
    });

    expect(context?.attached_run_ids).toHaveLength(16);
    expect(context?.attached_run_ids.at(-1)).toBe("run-current");
    const prompt = managerAgentDagContextPrompt(context);
    expect(prompt).toContain("authoritative read-only runtime data");
    expect(prompt).toContain('"current_run_id":"run-current"');
    expect(prompt).toContain("first call get_dag_supervision");
    expect(prompt).toContain("send_dag_actor_command");
    expect(prompt).toContain("keep sibling Actors unchanged");
    expect(prompt).toContain("Do not create a replacement generated-view Block");
  });

  it("omits invalid or empty DAG context", () => {
    expect(normalizeManagerAgentDagContext({
      context_version: 1,
      current_run_id: "\nunsafe",
      attached_run_ids: [],
    })).toBeUndefined();
    expect(managerAgentDagContextPrompt(undefined)).toBe("");
  });
});

describe("Manager Agent harness contract", () => {
  it("accepts official Kimi providers and explicitly custom model settings", () => {
    expect(isKimiCodeCompatibleModelSetting({ providerId: "kimi_cn" })).toBe(true);
    expect(isKimiCodeCompatibleModelSetting({
      providerId: "qwen36-local",
      providerSource: "custom",
    })).toBe(true);
    expect(isKimiCodeCompatibleModelSetting({
      providerId: "qwen36-local",
      planType: "custom",
      protocol: "openai_compatible",
    })).toBe(true);
  });

  it("rejects unrelated builtin providers even if their metadata is malformed", () => {
    expect(isKimiCodeCompatibleModelSetting({
      providerId: "deepseek",
      providerSource: "builtin",
      planType: "custom",
    })).toBe(false);
  });

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
    expect(managerAgentRuntimePlacementForHarness("kimi_code")).toBe("host_shell");
    expect(managerAgentRuntimePlacementForHarness("claude_agent_sdk")).toBe("host_shell");
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
    expect(managerAgentToolSpec("publish_artifact").input_schema.properties).toMatchObject({
      artifact_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" },
      expected_revision: { type: "integer", minimum: 0 },
    });
  });

  it("declares strict Manager Supervisor tool contracts", () => {
    const supervisorToolNames = [
      "start_supervised_dag",
      "list_dag_actors",
      "get_dag_supervision",
      "intervene_dag_actor",
      "send_dag_actor_command",
      "focus_dag_actor",
      "cancel_dag_run",
      "complete_dag_run",
    ] as const;
    const firstSupervisorTool = MANAGER_AGENT_COMMON_TOOL_NAMES.indexOf("start_supervised_dag");

    expect(MANAGER_AGENT_COMMON_TOOL_NAMES.slice(firstSupervisorTool, firstSupervisorTool + supervisorToolNames.length))
      .toEqual(supervisorToolNames);

    const expectedSchemas = {
      start_supervised_dag: {
        type: "object",
        properties: {
          yamlPath: { type: "string" },
          workflow_id: { type: "string" },
          workflowId: { type: "string" },
          profile: { type: "string" },
          prompt: { type: "string" },
          runId: { type: "string" },
        },
        anyOf: [
          { required: ["workflow_id"] },
          { required: ["workflowId"] },
          { required: ["yamlPath"] },
        ],
        additionalProperties: false,
      },
      list_dag_actors: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"],
        additionalProperties: false,
      },
      get_dag_supervision: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          max_milestones: { type: "integer", minimum: 1, maximum: 12 },
        },
        required: ["run_id"],
        additionalProperties: false,
      },
      intervene_dag_actor: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^(?=[^\\u0000-\\u001f\\u007f]*\\S)[^\\u0000-\\u001f\\u007f]+$",
          },
          actor_id: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^(?=[^\\u0000-\\u001f\\u007f]*\\S)[^\\u0000-\\u001f\\u007f]+$",
          },
          operation: { type: "string", enum: MANAGER_AGENT_DAG_ACTOR_INTERVENTION_OPERATIONS },
          instruction: { type: "string", minLength: 1, maxLength: 4096 },
          expected_state_token: { type: "string", minLength: 1, maxLength: 256 },
          idempotency_key: { type: "string", minLength: 1, maxLength: 256 },
          checkpoint_version: { type: "integer", minimum: 1 },
        },
        required: ["run_id", "actor_id", "operation", "expected_state_token", "idempotency_key"],
        allOf: [{
          if: {
            properties: { operation: { const: "checkpoint_fork" } },
            required: ["operation"],
          },
          then: {
            properties: { checkpoint_version: { type: "integer", minimum: 1 } },
            required: ["checkpoint_version"],
          },
          else: {
            not: {
              properties: { checkpoint_version: {} },
              required: ["checkpoint_version"],
            },
          },
        }],
        additionalProperties: false,
      },
      send_dag_actor_command: {
        type: "object",
        properties: {
          run_id: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^(?=[^\\u0000-\\u001f\\u007f]*\\S)[^\\u0000-\\u001f\\u007f]+$",
          },
          expected_round_id: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^(?=[^\\u0000-\\u001f\\u007f]*\\S)[^\\u0000-\\u001f\\u007f]+$",
          },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 128,
            items: {
              type: "object",
              properties: {
                actor_id: {
                  type: "string",
                  minLength: 1,
                  maxLength: 256,
                  pattern: "^(?=[^\\u0000-\\u001f\\u007f]*\\S)[^\\u0000-\\u001f\\u007f]+$",
                },
                idempotency_key: {
                  type: "string",
                  minLength: 1,
                  maxLength: 256,
                  pattern: "^(?=[^\\u0000-\\u001f\\u007f]*\\S)[^\\u0000-\\u001f\\u007f]+$",
                },
                expected_state_token: {
                  type: "string",
                  pattern: "^[0-9a-f]{64}$",
                },
                payload: {
                  description: "Actor command payload. Preserve semantic instructions and populate any applicable typed paths advertised by this Actor's latest command_payload_contract.",
                },
              },
              required: ["actor_id", "payload"],
              additionalProperties: false,
            },
          },
        },
        required: ["run_id", "commands"],
        additionalProperties: false,
      },
      focus_dag_actor: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          actor_id: { type: "string" },
          idempotency_key: { type: "string" },
          duration_ms: { type: "integer", minimum: 1000, maximum: 300000 },
        },
        required: ["run_id", "actor_id", "idempotency_key"],
        additionalProperties: false,
      },
      cancel_dag_run: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"],
        additionalProperties: false,
      },
      complete_dag_run: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          expected_round_id: { type: "string" },
        },
        required: ["run_id", "expected_round_id"],
        additionalProperties: false,
      },
    } as const;

    for (const name of supervisorToolNames) {
      const spec = managerAgentToolSpec(name);
      expect(spec.input_schema).toEqual(expectedSchemas[name]);
      expect(spec.description).toContain("stable actor_id");
      expect(spec.description).toContain("Worker or container IDs");
    }

    const intervention = managerAgentToolSpec("intervene_dag_actor");
    expect(intervention.description).toContain("get_dag_supervision");
    expect(intervention.description).toContain("expected_state_token");
    expect(intervention.description).toContain("Never infer physical execution targets");
  });

  it("exposes only the atomic batch DAG Actor command schema to models", () => {
    const spec = managerAgentToolSpec("send_dag_actor_command");
    const validate = new Ajv({ strict: true }).compile(spec.input_schema);
    expect(spec.description).toContain("command_payload_contract");
    expect(spec.description).toContain("never encode those constraints only in prose");
    const commandItems = spec.input_schema.properties?.commands?.items as {
      properties?: { payload?: { description?: string } };
    };
    expect(commandItems.properties?.payload?.description).toContain("typed paths");
    const legacy = {
      run_id: "run-supervised",
      actor_id: "research",
      expected_round_id: "round-0001",
      idempotency_key: "command-research-2",
      payload: { task: "continue" },
    };
    const batch = {
      run_id: "run-supervised",
      expected_round_id: "round-0001",
      commands: [
        { actor_id: "research", payload: { task: "continue research" } },
        { actor_id: "verify", payload: { task: "continue verification" } },
      ],
    };

    expect(validate(legacy)).toBe(false);
    expect(validate(batch)).toBe(true);
    expect(validate({
      ...batch,
      commands: Array.from({ length: 128 }, (_, index) => ({
        actor_id: `actor-${index}`,
        payload: index,
      })),
    })).toBe(true);

    const invalidInputs = [
      { ...legacy, expected_round_id: "" },
      { ...legacy, commands: batch.commands },
      { ...batch, actor_id: "research" },
      { ...batch, commands: [] },
      {
        ...batch,
        commands: Array.from({ length: 129 }, (_, index) => ({ actor_id: `actor-${index}`, payload: index })),
      },
      { ...batch, commands: [{ actor_id: "research" }] },
      { ...batch, commands: [{ actor_id: " ", payload: null }] },
      { ...batch, commands: [{ actor_id: "research", payload: null, worker_id: "forbidden" }] },
      { ...batch, unexpected: true },
    ];
    for (const input of invalidInputs) expect(validate(input), JSON.stringify(input)).toBe(false);
  });

  it("normalizes legacy and batch DAG Actor commands and rejects malformed batches", () => {
    expect(normalizeManagerAgentDagActorCommandInput({
      run_id: "  run /?# supervised  ",
      actor_id: "  research  ",
      expected_round_id: "  round-0001  ",
      idempotency_key: "  command-research-2  ",
      payload: { task: "continue" },
    })).toEqual({
      run_id: "run /?# supervised",
      expected_round_id: "round-0001",
      commands: [{
        actor_id: "research",
        idempotency_key: "command-research-2",
        payload: { task: "continue" },
      }],
    });
    expect(normalizeManagerAgentDagActorCommandInput({
      run_id: "  run-batch  ",
      expected_round_id: "  round-0002  ",
      commands: [
        { actor_id: "  research  ", payload: null },
        { actor_id: "verify", payload: false },
      ],
    })).toEqual({
      run_id: "run-batch",
      expected_round_id: "round-0002",
      commands: [
        { actor_id: "research", payload: null },
        { actor_id: "verify", payload: false },
      ],
    });

    expect(() => normalizeManagerAgentDagActorCommandInput({
      run_id: "run-batch",
      expected_round_id: "round-0001",
      commands: [],
    })).toThrow(/between 1 and 128 entries/);
    expect(() => normalizeManagerAgentDagActorCommandInput({
      run_id: "run-batch",
      expected_round_id: "round-0001",
      commands: [{ actor_id: "research" }],
    })).toThrow(/commands\[0\]\.payload is required/);
    expect(() => normalizeManagerAgentDagActorCommandInput({
      run_id: "run-batch",
      expected_round_id: "round-0001",
      commands: [{ actor_id: "research", payload: null, worker_id: "forbidden" }],
    })).toThrow(/commands\[0\].*additional properties: worker_id/);
    expect(() => normalizeManagerAgentDagActorCommandInput({
      run_id: "run-batch",
      expected_round_id: "round-0001",
      commands: [
        { actor_id: "research", payload: 1 },
        { actor_id: " research ", payload: 2 },
      ],
    })).toThrow(/unique actor_id/);
    expect(() => normalizeManagerAgentDagActorCommandInput({
      run_id: "run-batch",
      actor_id: "research",
      expected_round_id: "round-0001",
      idempotency_key: "legacy-key",
      payload: null,
      commands: [{ actor_id: "verify", payload: null }],
    })).toThrow(/either actor_id\/idempotency_key\/payload or commands, not both/);
    expect(() => normalizeManagerAgentDagActorCommandInput({
      run_id: "run-batch",
      expected_round_id: "round-0001",
      commands: [{ actor_id: "research", payload: null }],
      container_id: "forbidden",
    })).toThrow(/additional properties: container_id/);
  });

  it("rejects invalid and physical-target inputs for DAG Actor intervention", () => {
    const validate = new Ajv({ strict: true }).compile(
      managerAgentToolSpec("intervene_dag_actor").input_schema,
    );
    const valid = {
      run_id: "run-supervised",
      actor_id: "research",
      operation: "checkpoint_fork",
      instruction: "Retry from the verified checkpoint with the corrected constraint.",
      expected_state_token: "a".repeat(64),
      idempotency_key: "intervention-research-1",
      checkpoint_version: 3,
    };

    expect(validate(valid)).toBe(true);
    expect(validate({
      run_id: valid.run_id,
      actor_id: valid.actor_id,
      operation: "cancel",
      expected_state_token: valid.expected_state_token,
      idempotency_key: valid.idempotency_key,
    })).toBe(true);

    const invalidInputs = [
      { ...valid, operation: "restart" },
      {
        run_id: valid.run_id,
        actor_id: valid.actor_id,
        operation: "checkpoint_fork",
        expected_state_token: valid.expected_state_token,
        idempotency_key: valid.idempotency_key,
      },
      { ...valid, operation: "retry" },
      { ...valid, run_id: "" },
      { ...valid, run_id: "   " },
      { ...valid, run_id: "x".repeat(257) },
      { ...valid, run_id: "run\nbad" },
      { ...valid, actor_id: "" },
      { ...valid, actor_id: "x".repeat(257) },
      { ...valid, actor_id: "actor\u007fbad" },
      { ...valid, instruction: "" },
      { ...valid, instruction: "x".repeat(4097) },
      { ...valid, expected_state_token: "" },
      { ...valid, expected_state_token: "x".repeat(257) },
      { ...valid, idempotency_key: "" },
      { ...valid, idempotency_key: "x".repeat(257) },
      { ...valid, checkpoint_version: 0 },
      { ...valid, checkpoint_version: 1.5 },
      ...[
        "node_id",
        "worker_id",
        "container_id",
        "session_id",
        "lease_id",
        "generation",
        "revision",
        "target_id",
        "unexpected",
      ].map((field) => ({ ...valid, [field]: "forbidden" })),
    ];
    for (const input of invalidInputs) expect(validate(input), JSON.stringify(input)).toBe(false);
  });

  it("normalizes bounded identifiers and enforces checkpoint-only version semantics", () => {
    const base = {
      run_id: "  run-supervised  ",
      actor_id: "  research  ",
      operation: "retry",
      expected_state_token: "opaque-state-token",
      idempotency_key: "intervention-research-1",
    };
    expect(normalizeManagerAgentDagActorInterventionInput(base)).toEqual({
      ...base,
      run_id: "run-supervised",
      actor_id: "research",
    });
    expect(normalizeManagerAgentDagActorInterventionInput({
      ...base,
      operation: "checkpoint_fork",
      checkpoint_version: 2,
    })).toMatchObject({ operation: "checkpoint_fork", checkpoint_version: 2 });

    expect(() => normalizeManagerAgentDagActorInterventionInput({
      ...base,
      operation: "checkpoint_fork",
    })).toThrow(/checkpoint_version is required/);
    expect(() => normalizeManagerAgentDagActorInterventionInput({
      ...base,
      checkpoint_version: 2,
    })).toThrow(/only accepted for checkpoint_fork/);
    expect(() => normalizeManagerAgentDagActorInterventionInput({
      ...base,
      run_id: "x".repeat(257),
    })).toThrow(/run_id must be between 1 and 256 printable characters/);
    expect(() => normalizeManagerAgentDagActorInterventionInput({
      ...base,
      actor_id: "actor\nbad",
    })).toThrow(/actor_id must be between 1 and 256 printable characters/);
  });

  it("projects command responses onto the stable Actor-only contract", () => {
    const result = managerAgentDagCommandResult({
      success: true,
      message: "Waiting run resumed",
      data: {
        resumed: true,
        previous_round_id: "round-0001",
        round_id: "round-0002",
        ordinal: 2,
        actor_ids: ["research"],
        node_ids: ["private-node-research"],
        command_ids: ["command-research"],
        ready_node_ids: ["private-node-research"],
        dispatched: 1,
        deduplicated: true,
      },
    });

    expect(result).toEqual({
      delivery_mode: "round_resume",
      resumed: true,
      previous_round_id: "round-0001",
      round_id: "round-0002",
      ordinal: 2,
      actor_ids: ["research"],
      command_ids: ["command-research"],
      dispatched: 1,
      deduplicated: true,
    });
    expect(JSON.stringify(result)).not.toContain("node");
    expect(() => managerAgentDagCommandResult({ data: { resumed: true } })).toThrow(
      "previous_round_id",
    );
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

  it("builds one voice prompt contract for host harnesses", () => {
    const prompt = buildManagerAgentSystemPrompt({
      responseMode: "voice",
      runtime: { placement: "host_shell", provider: "kimi", model: "kimi-code" },
      voiceSystem: { source: "system:test", prompt: "VOICE_SYSTEM" },
      voiceUiRules: { sources: ["user:test"], hash: "abc123", prompt: "VOICE_RULES" },
    });
    expect(prompt).toContain("manager-agent host process");
    expect(prompt).toContain("VOICE_SYSTEM");
    expect(prompt).toContain("Voice UI rules hash: abc123");
    expect(prompt).toContain("VOICE_RULES");
    expect(prompt).toContain("Use tool-created widgets for generated UI");
    expect(prompt).toContain("User-facing replies describe the user's goal, the visible result");
    expect(prompt).toContain("这次没能把卡片放到画布，我可以继续重试。");
    expect(prompt).toContain("Commentary is spoken too");
    expect(prompt).toContain("never narrate Skill loading, tool names, read-only checks, rendering, or canvas updates");
    expect(prompt).toContain("inspect command_payload_contract");
    expect(prompt).toContain("never leave a machine-readable constraint only inside instruction text");
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

    expect(prompt).toContain("Validated Skill visual templates are available through skill_view_present");
    expect(prompt).toContain("pal-profile: Compact profile with a real icon.");
    expect(prompt).toContain("an unfinished visual contract");
    expect(prompt).toContain("call skill_view_render");
    expect(prompt).toContain("prefer one skill_view_present call over native shell");
    expect(prompt).toContain("unchanged data");
    expect(prompt).toContain("external facts, a domain Skill, or a visual result");
    expect(prompt).not.toContain("Use tools only when the user asks to inspect");
  });

  it("describes non-Codex manager agents as host processes", () => {
    const prompt = buildManagerAgentSystemPrompt({
      runtime: { placement: "host_shell", provider: "kimi", model: "kimi-k2.7" },
    });
    expect(prompt).toContain("manager-agent host process");
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

/**
 * Manager Agent tool catalog contract.
 * @version 0.1.0
 */

import type { AgentToolDefinition } from "./types.js";

export const MANAGER_AGENT_WIDGET_FILE_TYPES = [
  "memo",
  "task_draft",
  "progress_status",
  "checklist",
  "artifact_ref",
  "timeline",
] as const;

export type ManagerAgentWidgetFileType = (typeof MANAGER_AGENT_WIDGET_FILE_TYPES)[number];

export type ManagerAgentResponseMode = "chat" | "voice";

export const MANAGER_AGENT_COMMON_TOOL_NAMES = [
  "list_projects",
  "list_skills",
  "read_skill",
  "list_orchestrations",
  "list_dag_patterns",
  "get_dag_pattern",
  "instantiate_dag_pattern",
  "get_dag_schema",
  "validate_dag_workflow",
  "sync_dag_workflow",
  "create_change",
  "create_and_run",
  "invoke_run",
  "get_run_status",
  "run_shell_command",
  "finish",
] as const;

export const MANAGER_AGENT_COMMON_VOICE_TOOL_NAMES = [
  "update_voice_memo",
  "update_task_draft",
  "validate_widget_file",
  "write_widget_file",
  "read_widget_file",
  "remove_widget_file",
  "show_widget_toml_example",
  "show_status_card",
  "show_list_card",
  "show_progress_card",
  "show_note_card",
  "show_artifact_card",
  "show_dynamic_widget",
  "remove_widget",
  "update_voice_surface",
] as const;

export const MANAGER_AGENT_HOST_VOICE_TOOL_NAMES = [] as const;

export type ManagerAgentCommonToolName =
  | (typeof MANAGER_AGENT_COMMON_TOOL_NAMES)[number]
  | (typeof MANAGER_AGENT_COMMON_VOICE_TOOL_NAMES)[number];

export type ManagerAgentHostVoiceToolName = (typeof MANAGER_AGENT_HOST_VOICE_TOOL_NAMES)[number];

export type ManagerAgentToolName = ManagerAgentCommonToolName | ManagerAgentHostVoiceToolName;

export const HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL = "homerail_tool_call";
export const HOMERAIL_PROMPT_HANDOFF_PROTOCOL = "homerail_handoff";

export interface HomeRailPromptToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface HomeRailPromptHandoff {
  port: string;
  content: unknown;
  summary?: string;
}

const emptyObjectSchema = { type: "object", properties: {}, additionalProperties: false };

const widgetSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    widget_type: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    status: { type: "string" },
    priority: { type: "string", enum: ["low", "normal", "high"] },
    items: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    active_step: { type: "integer" },
    data: { type: "object", additionalProperties: true },
  },
  required: ["title"],
  additionalProperties: true,
};

const taskDraftSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    request: { type: "string" },
    acceptance: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["draft", "clarifying", "needs_confirmation", "submitted"] },
  },
  required: ["title"],
  additionalProperties: false,
};

const voiceMemoSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    status: { type: "string", enum: ["listening", "clarifying", "ready", "executing", "done"] },
    summary: { type: "string" },
    known_facts: { type: "array", maxItems: 8, items: { type: "string" } },
    open_questions: { type: "array", maxItems: 8, items: { type: "string" } },
    todos: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          done: { type: "boolean" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    next_action: { type: "string" },
    ready_to_execute: { type: "boolean" },
  },
  required: ["title", "status", "summary"],
  additionalProperties: false,
};

const updateVoiceSurfaceSchema = {
  type: "object",
  properties: {
    commentary_texts: { type: "array", maxItems: 6, items: { type: "string" } },
    progress: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["idle", "clarifying", "waiting_for_confirmation", "submitted", "running", "blocked", "done", "failed"],
        },
        short_text: { type: "string" },
      },
      additionalProperties: true,
    },
    task_draft: {
      type: "object",
      properties: {
        title: { type: "string" },
        request: { type: "string" },
        summary: { type: "string" },
        acceptance: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: ["draft", "clarifying", "needs_confirmation", "submitted"] },
      },
      additionalProperties: false,
    },
    widgets: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          status: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "high"] },
          items: { type: "array", items: { type: "string" } },
          steps: { type: "array", items: { type: "string" } },
          active_step: { type: "integer" },
          data: { type: "object", additionalProperties: true },
        },
        required: ["id", "type", "title"],
        additionalProperties: true,
      },
    },
    remove_widget_ids: { type: "array", maxItems: 8, items: { type: "string" } },
  },
  additionalProperties: false,
};

export const MANAGER_AGENT_TOOL_SPECS: Record<ManagerAgentToolName, AgentToolDefinition> = {
  list_projects: {
    name: "list_projects",
    description: "List projects known by the HomeRail Manager.",
    input_schema: emptyObjectSchema,
  },
  list_skills: {
    name: "list_skills",
    description: "List all enabled HomeRail skills discovered from HOMERAIL_HOME/skills with built-in fallbacks.",
    input_schema: emptyObjectSchema,
  },
  read_skill: {
    name: "read_skill",
    description: "Load the complete SKILL.md instructions for one HomeRail skill before applying it.",
    input_schema: {
      type: "object",
      properties: { skill_id: { type: "string" } },
      required: ["skill_id"],
      additionalProperties: false,
    },
  },
  list_orchestrations: {
    name: "list_orchestrations",
    description: "List repo-local orchestration YAML templates available to create runs.",
    input_schema: emptyObjectSchema,
  },
  list_dag_patterns: {
    name: "list_dag_patterns",
    description: "List built-in abstract DAG design patterns, roles, intended uses, avoid conditions, primitives, and parameters.",
    input_schema: emptyObjectSchema,
  },
  get_dag_pattern: {
    name: "get_dag_pattern",
    description: "Get one built-in DAG design pattern including its abstract workflow template.",
    input_schema: {
      type: "object",
      properties: { pattern_id: { type: "string" } },
      required: ["pattern_id"],
      additionalProperties: false,
    },
  },
  instantiate_dag_pattern: {
    name: "instantiate_dag_pattern",
    description: "Instantiate a built-in DAG pattern with typed parameters and sync the validated workflow to Manager by default.",
    input_schema: {
      type: "object",
      properties: {
        pattern_id: { type: "string" },
        parameters: { type: "object", additionalProperties: true },
        sync: { type: "boolean" },
      },
      required: ["pattern_id"],
      additionalProperties: false,
    },
  },
  get_dag_schema: {
    name: "get_dag_schema",
    description: "Fetch the live WorkflowSpec v1 JSON Schema and compiler version before authoring a custom DAG.",
    input_schema: emptyObjectSchema,
  },
  validate_dag_workflow: {
    name: "validate_dag_workflow",
    description: "Validate custom WorkflowSpec YAML or JSON without syncing or running it; returns structured source diagnostics and canonical metadata.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", maxLength: 262144 },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  sync_dag_workflow: {
    name: "sync_dag_workflow",
    description: "Sync a previously validated WorkflowSpec or legacy DAG source into Manager and create an immutable semantic revision when needed.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", maxLength: 262144 },
        source_path: { type: "string", maxLength: 1024 },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
  create_change: {
    name: "create_change",
    description: "Create a project change record. Use create_and_run to actually start a DAG run.",
    input_schema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
  },
  create_and_run: {
    name: "create_and_run",
    description: "Create and immediately invoke a DAG run from a DB workflow_id or repo-local YAML path.",
    input_schema: {
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
  },
  invoke_run: {
    name: "invoke_run",
    description: "Invoke or tick an existing DAG run.",
    input_schema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  get_run_status: {
    name: "get_run_status",
    description: "Get persisted status for a DAG run.",
    input_schema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  run_shell_command: {
    name: "run_shell_command",
    description: "Run a short shell command inside the project workspace for trusted Manager Agent inspection tasks.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  finish: {
    name: "finish",
    description: "Finish the Manager Agent turn with a concise user-facing summary.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  update_task_draft: {
    name: "update_task_draft",
    description: "把用户需求整理成当前任务草稿，并更新屏幕任务卡。大段内容必须放 summary/items，不要放入 final spoken text。",
    input_schema: taskDraftSchema,
  },
  update_voice_memo: {
    name: "update_voice_memo",
    description: [
      "Update the session voice memo as a local TOML file and render it to the stable voice-memo widget.",
      "Use this while listening to multi-turn user requirements before execution is ready.",
      "Treat the input as the complete current memo, not an append-only log.",
      "Preserve useful facts, mark answered todos as done, keep open questions compact, and set ready_to_execute only when the task is ready for confirmation.",
    ].join(" "),
    input_schema: voiceMemoSchema,
  },
  validate_widget_file: {
    name: "validate_widget_file",
    description: [
      "Manager-internal voice UI tool. Validate a TOML widget file body for the current voice surface without changing UI state.",
      `Supported widget_type values: ${MANAGER_AGENT_WIDGET_FILE_TYPES.join(", ")}.`,
      "Use validation errors to repair TOML, then call write_widget_file.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        widget_type: { type: "string", enum: MANAGER_AGENT_WIDGET_FILE_TYPES },
        toml: { type: "string" },
      },
      required: ["widget_type", "toml"],
      additionalProperties: false,
    },
  },
  write_widget_file: {
    name: "write_widget_file",
    description: [
      "Manager-internal voice UI tool. Atomically write one TOML widget file for the current session and refresh the normalized widget.",
      "Do not use it for arbitrary files. Use one file per widget and stable widget_id values so future turns update instead of duplicating cards.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        widget_type: { type: "string", enum: MANAGER_AGENT_WIDGET_FILE_TYPES },
        widget_id: { type: "string" },
        toml: { type: "string" },
      },
      required: ["widget_type", "toml"],
      additionalProperties: false,
    },
  },
  read_widget_file: {
    name: "read_widget_file",
    description: "Manager-internal voice UI tool. Read and normalize one existing TOML widget file from the current session.",
    input_schema: {
      type: "object",
      properties: {
        widget_id: { type: "string" },
        widget_type: { type: "string", enum: MANAGER_AGENT_WIDGET_FILE_TYPES },
      },
      required: ["widget_id"],
      additionalProperties: false,
    },
  },
  remove_widget_file: {
    name: "remove_widget_file",
    description: "Manager-internal voice UI tool. Remove one session TOML widget file and remove the matching widget from the voice surface.",
    input_schema: {
      type: "object",
      properties: { widget_id: { type: "string" } },
      required: ["widget_id"],
      additionalProperties: false,
    },
  },
  show_widget_toml_example: {
    name: "show_widget_toml_example",
    description: "Manager-internal voice UI tool. Return a canonical TOML example for a supported widget type.",
    input_schema: {
      type: "object",
      properties: { widget_type: { type: "string", enum: MANAGER_AGENT_WIDGET_FILE_TYPES } },
      required: ["widget_type"],
      additionalProperties: false,
    },
  },
  show_status_card: {
    name: "show_status_card",
    description: "显示一个状态卡，例如 Manager 正在处理、等待确认或遇到阻塞。",
    input_schema: widgetSchema,
  },
  show_list_card: {
    name: "show_list_card",
    description: "显示一个短列表卡。长列表必须压缩到 8 项以内。",
    input_schema: widgetSchema,
  },
  show_progress_card: {
    name: "show_progress_card",
    description: "显示一个进度卡，steps 为短步骤，active_step 为当前步骤索引。",
    input_schema: widgetSchema,
  },
  show_note_card: {
    name: "show_note_card",
    description: "显示一个说明或提示卡，body 承载不适合朗读的细节。",
    input_schema: widgetSchema,
  },
  show_artifact_card: {
    name: "show_artifact_card",
    description: "显示 HTML、图片或文件 artifact 预览卡。data 里优先放 artifact_path 或 path；不要猜 URL。",
    input_schema: widgetSchema,
  },
  show_dynamic_widget: {
    name: "show_dynamic_widget",
    description: "显示动态小组件。type 可为 html、metric_strip、timeline、dag_flow、chart、topic_outline、slide_deck 等。",
    input_schema: widgetSchema,
  },
  remove_widget: {
    name: "remove_widget",
    description: "移除指定屏幕 widget。",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  update_voice_surface: {
    name: "update_voice_surface",
    description: [
      "Compatibility tool for updating multiple voice UI fields at once. Prefer the specific tools update_task_draft and show_*_card when possible.",
      "For simple chat, do not call any UI tool unless a widget or progress update is genuinely useful.",
    ].join(" "),
    input_schema: updateVoiceSurfaceSchema,
  },
};

function cloneSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

export function managerAgentToolSpec(name: ManagerAgentToolName): AgentToolDefinition {
  const spec = MANAGER_AGENT_TOOL_SPECS[name];
  return {
    name: spec.name,
    description: spec.description,
    input_schema: cloneSchema(spec.input_schema),
  };
}

export function managerAgentCommonToolCatalog(responseMode: ManagerAgentResponseMode): AgentToolDefinition[] {
  const names: ManagerAgentCommonToolName[] = [
    ...MANAGER_AGENT_COMMON_TOOL_NAMES,
    ...(responseMode === "voice" ? MANAGER_AGENT_COMMON_VOICE_TOOL_NAMES : []),
  ];
  return names.map((name) => managerAgentToolSpec(name));
}

function decodePromptMarkerText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
}

function extractJsonMarkerObjects(text: string, markerTag: string): Record<string, unknown>[] {
  const normalized = decodePromptMarkerText(text);
  const markers: Record<string, unknown>[] = [];
  const pattern = new RegExp(`<${markerTag}>([\\s\\S]*?)<\\/${markerTag}>`, "g");
  for (const match of normalized.matchAll(pattern)) {
    if (!match[1]) continue;
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        markers.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Malformed marker bodies remain caller-visible text after stripping fails.
    }
  }
  return markers;
}

export function formatHomeRailPromptToolCall(call: HomeRailPromptToolCall): string {
  return `<${HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL}>${JSON.stringify({
    name: call.name,
    input: call.input ?? {},
  })}</${HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL}>`;
}

export function parseHomeRailPromptToolCalls(text: string): HomeRailPromptToolCall[] {
  return extractJsonMarkerObjects(text, HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL)
    .map((parsed): HomeRailPromptToolCall | null => {
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      const input = parsed.input && typeof parsed.input === "object" && !Array.isArray(parsed.input)
        ? parsed.input as Record<string, unknown>
        : {};
      return name ? { name, input } : null;
    })
    .filter((item): item is HomeRailPromptToolCall => Boolean(item));
}

export function formatHomeRailPromptHandoff(handoff: HomeRailPromptHandoff): string {
  return `<${HOMERAIL_PROMPT_HANDOFF_PROTOCOL}>${JSON.stringify({
    port: handoff.port,
    content: handoff.content,
    ...(handoff.summary ? { summary: handoff.summary } : {}),
  })}</${HOMERAIL_PROMPT_HANDOFF_PROTOCOL}>`;
}

export function parseHomeRailPromptHandoff(text: string): HomeRailPromptHandoff | null {
  const parsed = extractJsonMarkerObjects(text, HOMERAIL_PROMPT_HANDOFF_PROTOCOL)[0];
  if (!parsed) return null;
  const port = typeof parsed.port === "string" ? parsed.port.trim() : "";
  if (!port) return null;
  return {
    port,
    content: parsed.content ?? "",
    ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
  };
}

export function stripHomeRailPromptMarkers(text: string): string {
  return decodePromptMarkerText(text)
    .replace(new RegExp(`<${HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL}>[\\s\\S]*?<\\/${HOMERAIL_PROMPT_TOOL_CALL_PROTOCOL}>`, "g"), "")
    .replace(new RegExp(`<${HOMERAIL_PROMPT_HANDOFF_PROTOCOL}>[\\s\\S]*?<\\/${HOMERAIL_PROMPT_HANDOFF_PROTOCOL}>`, "g"), "")
    .trim();
}

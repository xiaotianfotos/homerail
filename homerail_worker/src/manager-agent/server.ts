import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createAgentClient } from "../agent/factory.js";
import type { AgentEvent, AgentRunContext, DagToolDefinition } from "../agent/types.js";
import {
  buildManagerAgentSystemPrompt,
  createManagerAgentWidgetFileTools,
  DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE,
  managerAgentToolSpec,
  normalizeManagerAgentRuntimeAgentType,
  type ManagerAgentWidgetFileToolAdapter,
  type ManagerAgentWidgetFileToolResult,
  type ManagerAgentToolName,
} from "homerail-protocol";

interface ManagerAgentConfig {
  provider_name?: string;
  model?: string;
  model_name?: string;
  api_key?: string;
  base_url?: string;
  agent_type?: string;
  project_workspace?: string;
}

interface ChatRequest {
  message?: string;
  project_id?: string;
  session_id?: string;
  continue_chat?: boolean;
  response_mode?: "chat" | "voice";
  required_tool_calls?: string[];
  history?: Array<{ role?: string; content?: string; timestamp?: string }>;
  agent_config?: ManagerAgentConfig;
  voice_ui_rules?: { prompt?: string; hash?: string; sources?: string[] };
  voice_system_contract?: { prompt?: string; source?: string };
}

interface ChatSession {
  session_id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  created_at: string;
  updated_at: string;
}

interface ToolTrace {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultTrace {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface VoiceSurfaceState {
  commentaryTexts: string[];
  progress: Record<string, unknown> | null;
  taskDraft: Record<string, unknown> | null;
  widgets: Record<string, unknown>[];
  removeWidgetIds: string[];
}

const sessions = new Map<string, ChatSession>();

class ManagerAgentTurnTimeoutError extends Error {
  readonly statusCode = 504;
  readonly data: Record<string, unknown>;

  constructor(timeoutMs: number, data: Record<string, unknown>) {
    super(`Manager Agent turn timed out after ${timeoutMs}ms`);
    this.name = "ManagerAgentTurnTimeoutError";
    this.data = data;
    Object.setPrototypeOf(this, ManagerAgentTurnTimeoutError.prototype);
  }
}

class ManagerAgentObjectiveUnsatisfiedError extends Error {
  readonly statusCode = 424;
  readonly data: Record<string, unknown>;

  constructor(data: Record<string, unknown>) {
    super("Manager Agent did not satisfy required tool calls");
    this.name = "ManagerAgentObjectiveUnsatisfiedError";
    this.data = data;
    Object.setPrototypeOf(this, ManagerAgentObjectiveUnsatisfiedError.prototype);
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function short(value: unknown, max = 4000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function compactDeltas(parts: string[]): string {
  return parts.join("").trim();
}

function normalizeRequiredToolCalls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean),
  ));
}

function managerRestUrl(): string {
  return (process.env.MANAGER_REST_URL || "http://host.docker.internal:19191/api").replace(/\/+$/, "");
}

function managerAgentTurnTimeoutMs(): number {
  const raw = Number(process.env.MANAGER_AGENT_TURN_TIMEOUT_MS ?? "0");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function projectWorkspace(): string {
  const configured = process.env.PROJECT_WORKSPACE || "/workspace/project";
  return fs.existsSync(configured) ? configured : process.cwd();
}

function safeCwd(raw?: unknown): string {
  const root = path.resolve(projectWorkspace());
  const requested = typeof raw === "string" && raw.trim()
    ? path.resolve(root, raw)
    : root;
  if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
    throw new Error("cwd is outside project workspace");
  }
  return requested;
}

function managerAgentShell(): { command: string; argsPrefix: string[] } {
  const configured = process.env.HOMERAIL_MANAGER_AGENT_SHELL || process.env.SHELL;
  if (configured && fs.existsSync(configured)) {
    return { command: configured, argsPrefix: ["-lc"] };
  }
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ];
    const gitBash = candidates.find((candidate) => fs.existsSync(candidate));
    if (gitBash) return { command: gitBash, argsPrefix: ["-lc"] };
    return { command: "cmd.exe", argsPrefix: ["/d", "/s", "/c"] };
  }
  return { command: "/bin/sh", argsPrefix: ["-lc"] };
}

async function requestManager(pathname: string, init?: RequestInit): Promise<unknown> {
  const url = `${managerRestUrl()}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Manager API ${res.status}: ${short(body, 800)}`);
  }
  return body;
}

function execReadonly(command: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const shell = managerAgentShell();
    execFile(shell.command, [...shell.argsPrefix, command], {
      cwd,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      env: process.env,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const code = typeof (err as NodeJS.ErrnoException | null)?.code === "number"
        ? Number((err as NodeJS.ErrnoException).code)
        : err
          ? 1
          : 0;
      resolve({ exitCode: code, stdout: short(stdout, 12000), stderr: short(stderr, 4000) });
    });
  });
}

function emptyVoiceSurface(): VoiceSurfaceState {
  return {
    commentaryTexts: [],
    progress: null,
    taskDraft: null,
    widgets: [],
    removeWidgetIds: [],
  };
}

function managerData(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    return record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : record;
  }
  return {};
}

function dataRecord(body: unknown): Record<string, unknown> {
  const data = body && typeof body === "object" && !Array.isArray(body) && "data" in body
    ? (body as { data?: unknown }).data
    : body;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

function widgetFromResult(result: Record<string, unknown>): Record<string, unknown> | undefined {
  return result.widget && typeof result.widget === "object" && !Array.isArray(result.widget)
    ? result.widget as Record<string, unknown>
    : undefined;
}

function createHttpWidgetFileToolAdapter(): ManagerAgentWidgetFileToolAdapter {
  return {
    async updateVoiceMemo(args, context): Promise<ManagerAgentWidgetFileToolResult> {
      const body = await requestManager("/voice-agent/widget-files/voice-memo", {
        method: "POST",
        body: JSON.stringify({
          project_id: context.projectId,
          session_id: context.sessionId,
          memo: args,
        }),
      });
      return { text: short(body), widget: widgetFromResult(dataRecord(body)) };
    },
    async validateWidgetFile(args): Promise<ManagerAgentWidgetFileToolResult> {
      const body = await requestManager("/voice-agent/widget-files/validate", {
        method: "POST",
        body: JSON.stringify({
          widget_type: args.widgetType,
          toml: args.toml,
        }),
      });
      const result = managerData(body);
      return { text: JSON.stringify(result), isError: result.ok === false };
    },
    async writeWidgetFile(args, context): Promise<ManagerAgentWidgetFileToolResult> {
      const body = await requestManager("/voice-agent/widget-files/write", {
        method: "POST",
        body: JSON.stringify({
          project_id: context.projectId,
          session_id: context.sessionId,
          widget_id: args.widgetId,
          widget_type: args.widgetType,
          toml: args.toml,
        }),
      });
      const result = managerData(body);
      return { text: JSON.stringify(result), isError: result.ok === false, widget: widgetFromResult(result) };
    },
    async readWidgetFile(args, context): Promise<ManagerAgentWidgetFileToolResult> {
      const body = await requestManager("/voice-agent/widget-files/read", {
        method: "POST",
        body: JSON.stringify({
          project_id: context.projectId,
          session_id: context.sessionId,
          widget_id: args.widgetId,
          widget_type: args.widgetType,
        }),
      });
      const result = managerData(body);
      return { text: JSON.stringify(result), isError: result.ok === false };
    },
    async removeWidgetFile(args, context): Promise<ManagerAgentWidgetFileToolResult> {
      const body = await requestManager("/voice-agent/widget-files/remove", {
        method: "POST",
        body: JSON.stringify({
          project_id: context.projectId,
          session_id: context.sessionId,
          widget_id: args.widgetId,
        }),
      });
      const result = managerData(body);
      const widgetId = typeof result.widget_id === "string" ? result.widget_id : args.widgetId;
      return { text: JSON.stringify(result), removeWidgetId: widgetId };
    },
    async showWidgetTomlExample(args): Promise<ManagerAgentWidgetFileToolResult> {
      const body = await requestManager("/voice-agent/widget-files/example", {
        method: "POST",
        body: JSON.stringify({ widget_type: args.widgetType }),
      });
      const result = managerData(body);
      return { text: typeof result.toml === "string" ? result.toml : JSON.stringify(result) };
    },
  };
}

function createManagerTools(state: {
  projectId?: string;
  sessionId?: string;
  createdRunIds: string[];
  finalNotes: string[];
  objectiveToolCalls: Array<{ name: string; success: boolean; error?: string; inferred?: boolean }>;
  voiceSurface: VoiceSurfaceState;
}, responseMode: "chat" | "voice"): DagToolDefinition[] {
  const tools: DagToolDefinition[] = [
    {
      name: "list_projects",
      description: "List projects known by the HomeRail Manager.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      async handler() {
        const body = await requestManager("/projects");
        return { content: [{ type: "text", text: short(body) }] };
      },
    },
    {
      name: "list_orchestrations",
      description: "List repo-local orchestration YAML templates available to create runs.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      async handler() {
        const dir = path.join(projectWorkspace(), "assets", "orchestrations");
        const files = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort()
          : [];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              root: "assets/orchestrations",
              files,
            }),
          }],
        };
      },
    },
    {
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
      async handler(args) {
        const projectId = String(args.project_id || "");
        try {
          const body = await requestManager(`/projects/${encodeURIComponent(projectId)}/changes`, {
            method: "POST",
            body: JSON.stringify({
              title: String(args.title || ""),
              description: typeof args.description === "string" ? args.description : undefined,
            }),
          });
          state.objectiveToolCalls.push({ name: "create_change", success: true });
          return { content: [{ type: "text", text: short(body) }] };
        } catch (err) {
          state.objectiveToolCalls.push({
            name: "create_change",
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    },
    {
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
      async handler(args) {
        try {
          const yamlPath = typeof args.yamlPath === "string" ? args.yamlPath.trim() : "";
          const workflowId = typeof args.workflow_id === "string" && args.workflow_id.trim()
            ? args.workflow_id.trim()
            : typeof args.workflowId === "string" && args.workflowId.trim()
              ? args.workflowId.trim()
              : "";
          if (!yamlPath && !workflowId) {
            throw new Error("create_and_run requires yamlPath or workflow_id");
          }
          const body = await requestManager("/runs/create-and-run", {
            method: "POST",
            body: JSON.stringify({
              yamlPath: yamlPath || undefined,
              workflow_id: workflowId || undefined,
              profile: typeof args.profile === "string" ? args.profile : undefined,
              prompt: typeof args.prompt === "string" ? args.prompt : undefined,
              runId: typeof args.runId === "string" ? args.runId : undefined,
            }),
          }) as Record<string, unknown>;
          const data = body.data as Record<string, unknown> | undefined;
          const runId = String(data?.runId ?? data?.run_id ?? "");
          if (runId) state.createdRunIds.push(runId);
          state.objectiveToolCalls.push({ name: "create_and_run", success: Boolean(runId) });
          return { content: [{ type: "text", text: short(body) }] };
        } catch (err) {
          state.objectiveToolCalls.push({
            name: "create_and_run",
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    },
    {
      name: "invoke_run",
      description: "Invoke or tick an existing DAG run.",
      input_schema: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
        additionalProperties: false,
      },
      async handler(args) {
        const runId = String(args.runId || "");
        try {
          const body = await requestManager(`/runs/${encodeURIComponent(runId)}/invoke`, { method: "POST", body: "{}" });
          state.objectiveToolCalls.push({ name: "invoke_run", success: true });
          return { content: [{ type: "text", text: short(body) }] };
        } catch (err) {
          state.objectiveToolCalls.push({
            name: "invoke_run",
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    },
    {
      name: "get_run_status",
      description: "Get persisted status for a DAG run.",
      input_schema: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
        additionalProperties: false,
      },
      async handler(args) {
        const runId = String(args.runId || "");
        const body = await requestManager(`/runs/${encodeURIComponent(runId)}/status`);
        return { content: [{ type: "text", text: short(body) }] };
      },
    },
    {
      name: "run_shell_command",
      description: "Run a short shell command inside the mounted project workspace for trusted Manager Agent inspection tasks.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      async handler(args) {
        const command = String(args.command || "");
        const result = await execReadonly(command, safeCwd(args.cwd));
        return { content: [{ type: "text", text: JSON.stringify(result) }], is_error: result.exitCode !== 0 };
      },
    },
    {
      name: "finish",
      description: "Finish the Manager Agent turn with a concise user-facing summary.",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async handler(args) {
        const text = String(args.text || "");
        state.finalNotes.push(text);
        return { content: [{ type: "text", text: "finished" }] };
      },
    },
  ];
  if (responseMode === "voice") {
    const addWidgetTool = (name: ManagerAgentToolName, widgetType: string): void => {
      tools.push({
        ...managerAgentToolSpec(name),
        async handler(args) {
          state.voiceSurface.widgets.push({
            ...args,
            type: name === "show_dynamic_widget"
              ? String(args.type || args.widget_type || widgetType)
              : widgetType,
          });
          return { content: [{ type: "text", text: "widget updated" }] };
        },
      });
    };
    tools.push({
      ...managerAgentToolSpec("update_task_draft"),
      async handler(args) {
        state.voiceSurface.taskDraft = args;
        return { content: [{ type: "text", text: "task draft updated" }] };
      },
    });
    tools.push(...createManagerAgentWidgetFileTools({
      adapter: createHttpWidgetFileToolAdapter(),
      context: { projectId: state.projectId, sessionId: state.sessionId },
      voiceSurface: {
        addWidget: (widget) => state.voiceSurface.widgets.push(widget),
        removeWidget: (id) => {
          if (id) state.voiceSurface.removeWidgetIds.push(id);
        },
      },
    }));
    addWidgetTool("show_status_card", "status");
    addWidgetTool("show_list_card", "list");
    addWidgetTool("show_progress_card", "progress");
    addWidgetTool("show_note_card", "note");
    addWidgetTool("show_artifact_card", "artifact");
    addWidgetTool("show_dynamic_widget", "html");
    tools.push({
      ...managerAgentToolSpec("remove_widget"),
      async handler(args) {
        const id = String(args.id || "").trim();
        if (id) state.voiceSurface.removeWidgetIds.push(id);
        return { content: [{ type: "text", text: "widget removed" }] };
      },
    });
    tools.push({
      ...managerAgentToolSpec("update_voice_surface"),
      async handler(args) {
        const commentary = Array.isArray(args.commentary_texts) ? args.commentary_texts : [];
        for (const item of commentary) {
          const text = String(item || "").trim();
          if (text) state.voiceSurface.commentaryTexts.push(text);
        }
        if (args.progress && typeof args.progress === "object" && !Array.isArray(args.progress)) {
          state.voiceSurface.progress = args.progress as Record<string, unknown>;
        }
        if (args.task_draft && typeof args.task_draft === "object" && !Array.isArray(args.task_draft)) {
          state.voiceSurface.taskDraft = args.task_draft as Record<string, unknown>;
        }
        if (Array.isArray(args.widgets)) {
          state.voiceSurface.widgets.push(
            ...args.widgets.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)),
          );
        }
        if (Array.isArray(args.remove_widget_ids)) {
          state.voiceSurface.removeWidgetIds.push(
            ...args.remove_widget_ids.map((item) => String(item || "").trim()).filter(Boolean),
          );
        }
        return { content: [{ type: "text", text: "voice surface updated" }] };
      },
    });
  }
  return tools;
}

function normalizeBackend(agentType: string | undefined): string {
  if (process.env.HOMERAIL_MANAGER_AGENT_SMOKE === "1" && process.env.AGENT_BACKEND === "manager-agent-smoke") {
    return "manager-agent-smoke";
  }
  return normalizeManagerAgentRuntimeAgentType(agentType) ?? DEFAULT_MANAGER_AGENT_RUNTIME_AGENT_TYPE;
}

function systemPrompt(
  config: ManagerAgentConfig | undefined,
  responseMode: "chat" | "voice" = "chat",
  voiceUiRules?: ChatRequest["voice_ui_rules"],
  voiceSystemContract?: ChatRequest["voice_system_contract"],
): string {
  const placement = process.env.HOMERAIL_MANAGER_AGENT_RUNTIME_PLACEMENT === "host_shell"
    ? "host_shell"
    : "container";
  return buildManagerAgentSystemPrompt({
    responseMode,
    runtime: {
      placement,
      provider: config?.provider_name || "unknown",
      model: config?.model || config?.model_name || "unknown",
    },
    voiceUiRules: responseMode === "voice" && voiceUiRules?.prompt
      ? {
          prompt: voiceUiRules.prompt,
          hash: voiceUiRules.hash,
          sources: Array.isArray(voiceUiRules.sources) ? voiceUiRules.sources : [],
        }
      : undefined,
    voiceSystem: responseMode === "voice" && voiceSystemContract?.prompt
      ? {
          prompt: voiceSystemContract.prompt,
          source: voiceSystemContract.source,
        }
      : undefined,
  });
}

function buildPrompt(session: ChatSession, message: string, continueChat: boolean): string {
  const history = continueChat
    ? session.messages.slice(-12).map((m) => `${m.role}: ${m.content}`).join("\n")
    : "";
  return history
    ? `Conversation history:\n${history}\n\nNew user message:\n${message}`
    : message;
}

function applyExternalHistory(session: ChatSession, history: ChatRequest["history"]): void {
  if (session.messages.length > 0 || !Array.isArray(history)) return;
  for (const item of history.slice(-24)) {
    const role = item.role === "user" || item.role === "assistant" ? item.role : undefined;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (role && content) session.messages.push({ role, content });
  }
}

async function handleChat(body: ChatRequest): Promise<Record<string, unknown>> {
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) throw new Error("Missing required field: message");
  const sessionId = body.session_id?.trim() || `manager-${randomUUID()}`;
  const now = new Date().toISOString();
  const session = sessions.get(sessionId) ?? {
    session_id: sessionId,
    messages: [],
    created_at: now,
    updated_at: now,
  };
  applyExternalHistory(session, body.history);
  const continueChat = body.continue_chat !== false;
  const state = {
    projectId: body.project_id,
    sessionId,
    createdRunIds: [] as string[],
    finalNotes: [] as string[],
    objectiveToolCalls: [] as Array<{ name: string; success: boolean; error?: string; inferred?: boolean }>,
    voiceSurface: emptyVoiceSurface(),
  };
  const toolCalls: ToolTrace[] = [];
  const toolResults: ToolResultTrace[] = [];
  const texts: string[] = [];
  const responseMode = body.response_mode === "voice" ? "voice" : "chat";
  const requiredToolCalls = normalizeRequiredToolCalls(body.required_tool_calls);
  const tools = createManagerTools(state, responseMode);
  const agent = createAgentClient(normalizeBackend(body.agent_config?.agent_type));
  const config = body.agent_config ?? {};
  const model = String(config.model || config.model_name || "");
  const turnTimeoutMs = managerAgentTurnTimeoutMs();
  const abortController = new AbortController();
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  if (turnTimeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, turnTimeoutMs);
    timeout.unref?.();
  }
  const context: AgentRunContext = {
    systemPrompt: systemPrompt(config, responseMode, body.voice_ui_rules, body.voice_system_contract),
    provider: config.provider_name,
    model,
    apiKey: String(config.api_key || ""),
    baseUrl: String(config.base_url || ""),
    workspace: projectWorkspace(),
    abortSignal: abortController.signal,
  };
  try {
    for await (const event of agent.run(buildPrompt(session, message, continueChat), tools, context)) {
      if (event.type === "text") {
        texts.push(event.text);
      } else if (event.type === "tool_use") {
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
      } else if (event.type === "tool_result") {
        toolResults.push({
          tool_use_id: event.tool_use_id,
          content: event.content,
          is_error: event.is_error,
        });
      } else if (event.type === "error") {
        texts.push(`[ERROR] ${event.message}`);
      }
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
  if (timedOut && !state.objectiveToolCalls.some((item) => item.success)) {
    throw new ManagerAgentTurnTimeoutError(turnTimeoutMs, {
      observed_tool_calls: toolCalls.map((item) => item.name),
      objective_tool_calls: state.objectiveToolCalls,
      run_ids: state.createdRunIds,
    });
  }
  const missingRequiredToolCalls = requiredToolCalls.filter((name) =>
    !state.objectiveToolCalls.some((item) => item.name === name && item.success)
  );
  if (missingRequiredToolCalls.length > 0) {
    throw new ManagerAgentObjectiveUnsatisfiedError({
      required_tool_calls: requiredToolCalls,
      missing_tool_calls: missingRequiredToolCalls,
      observed_tool_calls: toolCalls.map((item) => item.name),
      objective_tool_calls: state.objectiveToolCalls,
      run_ids: state.createdRunIds,
    });
  }
  const finalText = state.finalNotes.at(-1) || compactDeltas(texts) ||
    (timedOut && state.createdRunIds.length
      ? `Manager Agent timed out after starting run ${state.createdRunIds.at(-1)}.`
      : state.createdRunIds.length
      ? `Started DAG run ${state.createdRunIds.at(-1)}.`
      : "Manager Agent turn completed.");
  session.messages.push({ role: "user", content: message }, { role: "assistant", content: finalText });
  session.updated_at = new Date().toISOString();
  sessions.set(sessionId, session);
  return {
    text: finalText,
    ...(responseMode === "voice"
      ? {
        spoken_text: finalText,
        voice_surface: {
          progress: state.voiceSurface.progress,
          task_draft: state.voiceSurface.taskDraft,
          widgets: state.voiceSurface.widgets,
          remove_widget_ids: state.voiceSurface.removeWidgetIds,
        },
        progress: state.voiceSurface.progress,
        task_draft: state.voiceSurface.taskDraft,
        widgets: state.voiceSurface.widgets,
        remove_widget_ids: state.voiceSurface.removeWidgetIds,
      }
      : {}),
    session_id: sessionId,
    run_id: state.createdRunIds.at(-1) ?? null,
    run_ids: state.createdRunIds,
    objective: {
      required: requiredToolCalls.length > 0,
      required_tool_calls: requiredToolCalls,
      tool_calls: state.objectiveToolCalls,
      satisfied: requiredToolCalls.length === 0
        ? state.objectiveToolCalls.length === 0 || state.objectiveToolCalls.some((item) => item.success)
        : requiredToolCalls.every((name) => state.objectiveToolCalls.some((item) => item.name === name && item.success)),
    },
    tool_calls: toolCalls,
    tool_results: toolResults,
    commentary_texts: state.voiceSurface.commentaryTexts,
    project_id: body.project_id ?? process.env.PROJECT_ID ?? null,
  };
}

export function startManagerAgentServer(port = Number(process.env.MANAGER_AGENT_PORT || "9001")): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        status: "running",
        service: "manager-agent",
        worker_id: process.env.WORKER_ID || process.env.HOMERAIL_WORKER_ID || null,
        project_id: process.env.PROJECT_ID || null,
        fingerprint: process.env.HOMERAIL_MANAGER_AGENT_FINGERPRINT || null,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/chat") {
      readJsonBody(req)
        .then((body) => handleChat(body as ChatRequest))
        .then((result) => json(res, 200, result))
        .catch((err) => {
          if (err instanceof ManagerAgentTurnTimeoutError) {
            json(res, err.statusCode, { error: err.message, data: err.data });
            return;
          }
          if (err instanceof ManagerAgentObjectiveUnsatisfiedError) {
            json(res, err.statusCode, { error: err.message, data: err.data });
            return;
          }
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }
    json(res, 404, { error: "not found" });
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[homerail_worker] manager-agent server listening on ${port}`);
  });
  return server;
}

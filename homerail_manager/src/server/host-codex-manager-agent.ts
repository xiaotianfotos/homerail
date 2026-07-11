import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { ensureDefaultWorkspacePath, getHomerailHome } from "../config/env.js";
import { codexBinaryNotFoundMessage, resolveCodexBinary } from "./codex-binary.js";
import {
  readWidgetFile,
  removeWidgetFile,
  validateWidgetToml,
  voiceMemoToWidgetToml,
  widgetFilePath,
  widgetTomlExample,
  writeWidgetFile,
} from "../widgets/widget-file-protocol.js";
import type { ManagerAgentRuntimeConfig } from "./manager-agent-container.js";
import {
  buildManagerAgentSystemPrompt,
  createManagerAgentWidgetFileTools,
  managerAgentToolSpec,
  type ManagerAgentWidgetFileToolAdapter,
  type ManagerAgentWidgetFileToolResult,
  type ManagerAgentToolName,
  type ManagerAgentReasoningEffort,
  type ManagerAgentPromptSkill,
} from "homerail-protocol";

type ToolHandlerResult = {
  content: Array<{ type: "text"; text: string }>;
  is_error?: boolean;
};

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
}

interface VoiceSurfaceState {
  commentaryTexts: string[];
  progress: Record<string, unknown> | null;
  taskDraft: Record<string, unknown> | null;
  widgets: Record<string, unknown>[];
  removeWidgetIds: string[];
}

interface VoiceMemoTodo {
  text: string;
  done: boolean;
}

interface VoiceMemo {
  title: string;
  status: "listening" | "clarifying" | "ready" | "executing" | "done";
  summary: string;
  known_facts: string[];
  open_questions: string[];
  todos: VoiceMemoTodo[];
  next_action: string;
  ready_to_execute: boolean;
}

type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "debug"; source: string; message: string; data?: Record<string, unknown> }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "error"; message: string }
  | { type: "turn_complete" }
  | { type: "done" };

interface AgentRunContext {
  systemPrompt?: string;
  provider?: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  workspace?: string;
  maxIterations?: number;
  abortSignal?: AbortSignal;
  reasoning_effort?: ManagerAgentReasoningEffort;
  service_tier?: string | null;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type CodexReasoningEffort = NonNullable<AgentRunContext["reasoning_effort"]>;

export interface HostCodexManagerAgentInput {
  message: string;
  project_id?: string;
  session_id?: string;
  voice_session_id?: string;
  continue_chat?: boolean;
  history?: Array<{ role?: string; content?: string; timestamp?: string }>;
  agent_config: ManagerAgentRuntimeConfig;
  managerRestUrl?: string | (() => string);
  response_mode?: "chat" | "voice";
  voice_ui_rules?: VoiceUiRules;
  manager_skills?: ManagerAgentPromptSkill[];
}

export type HostCodexManagerAgentRunner = (
  input: HostCodexManagerAgentInput,
) => Promise<Record<string, unknown>>;

export type HostCodexManagerAgentStreamEvent =
  | { type: "commentary"; text: string; source: "tool" | "voice_surface" }
  | { type: "result"; result: Record<string, unknown> };

export type HostCodexManagerAgentStreamRunner = (
  input: HostCodexManagerAgentInput,
) => AsyncIterable<HostCodexManagerAgentStreamEvent>;

let hostRunnerOverride: HostCodexManagerAgentRunner | undefined;
let hostStreamRunnerOverride: HostCodexManagerAgentStreamRunner | undefined;

export function _setHostCodexManagerAgentRunnerForTest(runner?: HostCodexManagerAgentRunner): void {
  hostRunnerOverride = runner;
}

export function _setHostCodexManagerAgentStreamRunnerForTest(runner?: HostCodexManagerAgentStreamRunner): void {
  hostStreamRunnerOverride = runner;
}

export function _buildCodexAppServerArgsForTest(): string[] {
  return ["app-server"];
}

export function _buildCodexThreadStartParamsForTest(input: {
  systemPrompt?: string;
  cwd: string;
  model: string;
  provider?: string;
  serviceTier?: string | null;
  sandbox: string;
  dynamicTools: Array<Record<string, unknown>>;
  reasoningEffort?: CodexReasoningEffort;
}): Record<string, unknown> {
  return {
    baseInstructions: input.systemPrompt ?? null,
    developerInstructions: null,
    cwd: input.cwd,
    model: input.model,
    modelProvider: input.provider || null,
    serviceTier: input.serviceTier ?? null,
    approvalPolicy: "never",
    sandbox: input.sandbox,
    ephemeral: true,
    dynamicTools: input.dynamicTools,
    ...(input.reasoningEffort ? { config: { model_reasoning_effort: input.reasoningEffort } } : {}),
  };
}

export function _buildCodexTurnStartParamsForTest(input: {
  threadId: string;
  prompt?: string;
  cwd: string;
  model: string;
  reasoningEffort?: CodexReasoningEffort;
  serviceTier?: string | null;
}): Record<string, unknown> {
  return {
    threadId: input.threadId,
    input: input.prompt ? [{ type: "text", text: input.prompt, text_elements: [] }] : [],
    cwd: input.cwd,
    model: input.model,
    ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
    serviceTier: input.serviceTier ?? null,
  };
}

const CLIENT_NAME = "homerail_host_codex_manager_agent";
const CLIENT_TITLE = "HomeRail Host Codex Manager Agent";
const DEFAULT_CODEX_BIN = "codex";
const RESPONSE_TIMEOUT_MS = 60_000;

function managerAgentTurnTimeoutMs(): number {
  const raw = Number(process.env.MANAGER_AGENT_TURN_TIMEOUT_MS ?? "0");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

const SECRET_KEYS = [
  "apiKey",
  "api_key",
  "OPENAI_API_KEY",
  "Authorization",
  "auth_token",
  "secret",
];

function short(value: unknown, max = 4000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function managerRestUrl(raw?: string | (() => string)): string {
  const value = typeof raw === "function"
    ? raw()
    : raw || process.env.MANAGER_REST_URL || process.env.HOMERAIL_MANAGER_REST_URL || `http://127.0.0.1:${process.env.HOMERAIL_MANAGER_PORT || "19191"}/api`;
  let trimmed = value.replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.hostname === "host.docker.internal") {
      url.hostname = "127.0.0.1";
      trimmed = url.toString().replace(/\/+$/, "");
    }
  } catch {
    // Leave non-URL values untouched; the subsequent fetch will surface the error.
  }
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function _managerRestUrlForTest(raw?: string | (() => string)): string {
  return managerRestUrl(raw);
}

function workspaceFromConfig(config: ManagerAgentRuntimeConfig): string {
  const configured = config.project_workspace || process.env.HOMERAIL_PROJECT_WORKSPACE || process.env.HOMERAIL_REPO_ROOT;
  if (configured && fs.existsSync(configured) && fs.statSync(configured).isDirectory()) {
    return path.resolve(configured);
  }
  return ensureDefaultWorkspacePath();
}

export function _workspaceFromConfigForTest(config: ManagerAgentRuntimeConfig): string {
  return workspaceFromConfig(config);
}

function voiceMemoPath(projectId?: string, sessionId?: string): string {
  return widgetFilePath(projectId, sessionId, "voice-memo");
}

export function _voiceMemoPathForTest(projectId?: string, sessionId?: string): string {
  return voiceMemoPath(projectId, sessionId);
}

function stringArray(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, maxItems);
}

function normalizeMemoStatus(value: unknown): VoiceMemo["status"] {
  return value === "clarifying" || value === "ready" || value === "executing" || value === "done"
    ? value
    : "listening";
}

function normalizeVoiceMemo(args: Record<string, unknown>): VoiceMemo {
  const todos = Array.isArray(args.todos)
    ? args.todos
      .map((item): VoiceMemoTodo | null => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const raw = item as Record<string, unknown>;
        const text = String(raw.text || "").trim();
        if (!text) return null;
        return { text, done: raw.done === true };
      })
      .filter((item): item is VoiceMemoTodo => Boolean(item))
      .slice(0, 10)
    : [];
  return {
    title: String(args.title || "任务记录").trim() || "任务记录",
    status: normalizeMemoStatus(args.status),
    summary: String(args.summary || "").trim(),
    known_facts: stringArray(args.known_facts),
    open_questions: stringArray(args.open_questions),
    todos,
    next_action: String(args.next_action || "").trim(),
    ready_to_execute: args.ready_to_execute === true,
  };
}

function memoToToml(memo: VoiceMemo): string {
  return voiceMemoToWidgetToml(memo);
}

function memoWidget(memo: VoiceMemo, memoPath: string): Record<string, unknown> {
  const rendered = validateWidgetToml(memoToToml(memo), "memo", { filePath: memoPath });
  if (rendered.ok) return rendered.widget;
  throw new Error(`invalid memo widget: ${JSON.stringify(rendered.errors)}`);
}

export function _renderVoiceMemoForTest(args: Record<string, unknown>, memoPath = "/tmp/voice-memo.toml"): {
  memo: VoiceMemo;
  toml: string;
  widget: Record<string, unknown>;
} {
  const memo = normalizeVoiceMemo(args);
  return { memo, toml: memoToToml(memo), widget: memoWidget(memo, memoPath) };
}

export function writeVoiceMemoWidget(params: {
  projectId?: string | null;
  sessionId?: string | null;
  input: Record<string, unknown>;
}): {
  memo: VoiceMemo;
  memo_path: string;
  widget_id: "voice-memo";
  status: VoiceMemo["status"];
  write_result: ReturnType<typeof writeWidgetFile>;
  widget?: Record<string, unknown>;
} {
  const memo = normalizeVoiceMemo(params.input);
  const memoPath = voiceMemoPath(params.projectId ?? undefined, params.sessionId ?? undefined);
  const writeResult = writeWidgetFile({
    projectId: params.projectId ?? undefined,
    sessionId: params.sessionId ?? undefined,
    widgetId: "voice-memo",
    widgetType: "memo",
    tomlContent: memoToToml(memo),
  });
  return {
    memo,
    memo_path: memoPath,
    widget_id: "voice-memo",
    status: memo.status,
    write_result: writeResult,
    widget: writeResult.ok ? writeResult.widget : undefined,
  };
}

function createLocalWidgetFileToolAdapter(): ManagerAgentWidgetFileToolAdapter {
  return {
    async updateVoiceMemo(args, context): Promise<ManagerAgentWidgetFileToolResult> {
      const written = writeVoiceMemoWidget({
        projectId: context.projectId,
        sessionId: context.sessionId,
        input: args,
      });
      if (!written.write_result.ok) {
        return {
          isError: true,
          text: JSON.stringify({
            ok: false,
            errors: written.write_result.errors,
            file: written.write_result.file,
          }),
        };
      }
      return {
        text: JSON.stringify({
          memo_path: written.memo_path,
          widget_id: written.widget_id,
          status: written.status,
        }),
        widget: written.write_result.widget,
      };
    },
    async validateWidgetFile(args): Promise<ManagerAgentWidgetFileToolResult> {
      const result = validateWidgetToml(args.toml, args.widgetType);
      return { text: JSON.stringify(result), isError: !result.ok };
    },
    async writeWidgetFile(args, context): Promise<ManagerAgentWidgetFileToolResult> {
      const result = writeWidgetFile({
        projectId: context.projectId,
        sessionId: context.sessionId,
        widgetId: args.widgetId,
        widgetType: args.widgetType,
        tomlContent: args.toml,
      });
      return { text: JSON.stringify(result), isError: !result.ok, widget: result.ok ? result.widget : undefined };
    },
    async readWidgetFile(args, context): Promise<ManagerAgentWidgetFileToolResult> {
      const result = readWidgetFile({
        projectId: context.projectId,
        sessionId: context.sessionId,
        widgetId: args.widgetId,
        widgetType: args.widgetType,
      });
      return { text: JSON.stringify(result), isError: !result.ok };
    },
    async removeWidgetFile(args, context): Promise<ManagerAgentWidgetFileToolResult> {
      const result = removeWidgetFile({
        projectId: context.projectId,
        sessionId: context.sessionId,
        widgetId: args.widgetId,
      });
      return { text: JSON.stringify(result), removeWidgetId: result.widget_id };
    },
    async showWidgetTomlExample(args): Promise<ManagerAgentWidgetFileToolResult> {
      return { text: widgetTomlExample(args.widgetType) };
    },
  };
}

function safeCwd(root: string, raw?: unknown): string {
  const resolvedRoot = path.resolve(root);
  const requested = typeof raw === "string" && raw.trim()
    ? path.resolve(resolvedRoot, raw)
    : resolvedRoot;
  if (requested !== resolvedRoot && !requested.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("cwd is outside project workspace");
  }
  return requested;
}

async function requestManager(restUrl: string, pathname: string, init?: RequestInit): Promise<unknown> {
  const url = `${restUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
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

function execReadonly(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-lc", command], {
      cwd,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      env: process.env,
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

function createManagerTools(state: {
  restUrl: string;
  workspace: string;
  projectId?: string;
  sessionId?: string;
  createdRunIds: string[];
  finalNotes: string[];
  objectiveToolCalls: Array<{ name: string; success: boolean; error?: string }>;
  voiceSurface: VoiceSurfaceState;
}, responseMode: "chat" | "voice"): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "list_projects",
      description: "List projects known by the HomeRail Manager.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      async handler() {
        const body = await requestManager(state.restUrl, "/projects");
        return { content: [{ type: "text", text: short(body) }] };
      },
    },
    {
      ...managerAgentToolSpec("list_skills"),
      async handler() {
        const body = await requestManager(state.restUrl, "/skills");
        return { content: [{ type: "text", text: short(body, 12000) }] };
      },
    },
    {
      ...managerAgentToolSpec("read_skill"),
      async handler(args) {
        const skillId = String(args.skill_id || "").trim();
        if (!skillId) throw new Error("read_skill requires skill_id");
        const body = await requestManager(state.restUrl, `/skills/${encodeURIComponent(skillId)}`);
        return { content: [{ type: "text", text: short(body, 30000) }] };
      },
    },
    {
      name: "list_orchestrations",
      description: "List repo-local orchestration YAML templates available to create runs.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      async handler() {
        const dir = path.join(state.workspace, "assets", "orchestrations");
        const files = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort()
          : [];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ root: "assets/orchestrations", files }),
          }],
        };
      },
    },
    {
      ...managerAgentToolSpec("list_dag_patterns"),
      async handler() {
        const body = await requestManager(state.restUrl, "/dag/patterns");
        return { content: [{ type: "text", text: short(body, 20000) }] };
      },
    },
    {
      ...managerAgentToolSpec("get_dag_pattern"),
      async handler(args) {
        const patternId = String(args.pattern_id || "").trim();
        if (!patternId) throw new Error("get_dag_pattern requires pattern_id");
        const body = await requestManager(state.restUrl, `/dag/patterns/${encodeURIComponent(patternId)}`);
        return { content: [{ type: "text", text: short(body, 30000) }] };
      },
    },
    {
      ...managerAgentToolSpec("instantiate_dag_pattern"),
      async handler(args) {
        const patternId = String(args.pattern_id || "").trim();
        if (!patternId) throw new Error("instantiate_dag_pattern requires pattern_id");
        try {
          const instantiated = await requestManager(
            state.restUrl,
            `/dag/patterns/${encodeURIComponent(patternId)}/instantiate`,
            {
              method: "POST",
              body: JSON.stringify({
                parameters: args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters)
                  ? args.parameters
                  : {},
              }),
            },
          ) as Record<string, unknown>;
          const data = instantiated.data as Record<string, unknown> | undefined;
          const yamlText = typeof data?.yaml_text === "string" ? data.yaml_text : "";
          const shouldSync = args.sync !== false;
          let syncResult: unknown = null;
          if (shouldSync) {
            if (!yamlText) throw new Error("Pattern instantiation did not return yaml_text");
            syncResult = await requestManager(state.restUrl, "/dag/workflows/sync", {
              method: "POST",
              body: JSON.stringify({ yaml_text: yamlText, source_path: `builtin:${patternId}` }),
            });
          }
          state.objectiveToolCalls.push({ name: "instantiate_dag_pattern", success: true });
          return {
            content: [{
              type: "text",
              text: short({
                pattern_id: patternId,
                parameters: data?.parameters,
                workflow: data?.workflow,
                validation: data?.validation,
                synced: shouldSync,
                sync: syncResult,
              }, 16000),
            }],
          };
        } catch (error) {
          state.objectiveToolCalls.push({
            name: "instantiate_dag_pattern",
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    },
    {
      ...managerAgentToolSpec("get_dag_schema"),
      async handler() {
        const body = await requestManager(state.restUrl, "/dag/schema");
        return { content: [{ type: "text", text: short(body, 50000) }] };
      },
    },
    {
      ...managerAgentToolSpec("validate_dag_workflow"),
      async handler(args) {
        const source = typeof args.source === "string" ? args.source : "";
        if (!source.trim()) throw new Error("validate_dag_workflow requires source");
        const body = await requestManager(state.restUrl, "/dag/validate", {
          method: "POST",
          body: JSON.stringify({ source }),
        });
        return { content: [{ type: "text", text: short(body, 50000) }] };
      },
    },
    {
      ...managerAgentToolSpec("sync_dag_workflow"),
      async handler(args) {
        const source = typeof args.source === "string" ? args.source : "";
        if (!source.trim()) throw new Error("sync_dag_workflow requires source");
        const body = await requestManager(state.restUrl, "/dag/workflows/sync", {
          method: "POST",
          body: JSON.stringify({
            yaml_text: source,
            source_path: typeof args.source_path === "string" ? args.source_path : "manager-agent",
          }),
        });
        state.objectiveToolCalls.push({ name: "sync_dag_workflow", success: true });
        return { content: [{ type: "text", text: short(body, 30000) }] };
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
          const body = await requestManager(state.restUrl, `/projects/${encodeURIComponent(projectId)}/changes`, {
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
          const body = await requestManager(state.restUrl, "/runs/create-and-run", {
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
          const body = await requestManager(state.restUrl, `/runs/${encodeURIComponent(runId)}/invoke`, {
            method: "POST",
            body: "{}",
          });
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
        const body = await requestManager(state.restUrl, `/runs/${encodeURIComponent(runId)}/status`);
        return { content: [{ type: "text", text: short(body) }] };
      },
    },
    {
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
      async handler(args) {
        const result = await execReadonly(String(args.command || ""), safeCwd(state.workspace, args.cwd));
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
      adapter: createLocalWidgetFileToolAdapter(),
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

export function _hostCodexVoiceToolCatalogForTest(): Array<{ name: string; description: string }> {
  return createManagerTools({
    restUrl: "http://127.0.0.1:0/api",
    workspace: process.cwd(),
    projectId: "test-project",
    sessionId: "test-session",
    createdRunIds: [],
    finalNotes: [],
    objectiveToolCalls: [],
    voiceSurface: emptyVoiceSurface(),
  }, "voice").map((tool) => ({ name: tool.name, description: tool.description }));
}

export async function _invokeHostCodexVoiceToolForTest(
  name: string,
  args: Record<string, unknown>,
  options: { projectId?: string; sessionId?: string; managerRestUrl?: string } = {},
): Promise<{ result: ToolHandlerResult; voiceSurface: VoiceSurfaceState }> {
  const voiceSurface = emptyVoiceSurface();
  const tools = createManagerTools({
    restUrl: options.managerRestUrl ?? "http://127.0.0.1:0/api",
    workspace: process.cwd(),
    projectId: options.projectId ?? "test-project",
    sessionId: options.sessionId ?? "test-session",
    createdRunIds: [],
    finalNotes: [],
    objectiveToolCalls: [],
    voiceSurface,
  }, "voice");
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`unknown test tool: ${name}`);
  return { result: await tool.handler(args), voiceSurface };
}

const BUILTIN_VOICE_UI_PRINCIPLES = [
  "# Voice Agent UI Principles",
  "",
  "语音工作区的生成式 UI 为态势感知服务，不是聊天记录、文档页或装饰性卡片。",
  "",
  "规则来源：",
  "- HomeRail 在代码中提供基准规则。",
  "- 用户可以在 ~/.homerail/asset/voice-agent/ui-rules.md 写自己的语音 UI 偏好。",
  "- 语音 Agent 在 session 开始时加载基准规则和用户规则，用户规则作为偏好 overlay。",
  "",
  "当前只允许两个主面板：",
  "- 任务态势：当前目标、验收、约束、确认状态、source issue。",
  "- 执行/DAG 态势：提交状态、source issue、DAG 是否启动、节点进展、阻塞和下一步。",
  "",
  "Widget 原则：",
  "- Widget 是主面板里的结构化片段，不是随意铺满画布的独立卡片。",
  "- 单轮最多生成 2 个 widget。",
  "- Widget 必须有生命周期语义：data.ui_state 可为 visible、minimized、hidden。",
  "- 临时 widget 应能被后续同 id widget 覆盖，或通过 hidden 隐藏。",
  "- 避免重复任务草稿、重复提交状态和低信息量标题。",
  "- 用户还在连续说需求时，优先维护一个稳定的 memo / task-draft widget，而不是不断新增卡片。",
  "- 需要持久化的生成式 UI 使用 Manager 内部 Widget File Protocol：一个 widget 一个 TOML 文件，先校验再渲染。",
  "",
  "语音状态原则：",
  "- AI 正在播报时，界面必须明确暗示用户暂时不要输入语音。",
  "- 录音、思考、播报是不同状态，不能共用同一个提示。",
].join("\n");

const BUILTIN_VOICE_GENERATIVE_UI_SKILL = [
  "# Voice Generative UI Skill",
  "",
  "Use this skill in voice mode whenever the Agent needs to present structured state.",
  "",
  "## Role",
  "",
  "The voice surface is a listening and confirmation surface first. It should show that the Agent is remembering what the user said, narrowing ambiguity, and waiting until the task is ready before execution.",
  "",
  "## Default Behavior",
  "",
  "- Simple chat and capability questions: no widget.",
  "- Small local facts: usually no widget; at most one note widget if the fact must stay visible.",
  "- Multi-turn task discussion: maintain one stable memo/task widget.",
  "- Real execution or DAG state: use status/progress widgets only when backed by a real run id, blocker, or tool result.",
  "",
  "## Widget Tool Catalog",
  "",
  "Use these tools as the only way to create generated UI in voice mode:",
  "",
  "- update_voice_memo: the default listening widget. It writes the complete current memo to TOML and renders voice-memo.",
  "- validate_widget_file, write_widget_file, read_widget_file, remove_widget_file: Manager-internal Widget File Protocol tools for custom persisted widgets. Use validate_widget_file before write_widget_file when drafting non-memo TOML.",
  "- update_task_draft: use only when the task is already structured enough to ask for confirmation.",
  "- show_status_card: execution or blocker status backed by a real run id, tool result, or explicit blocker.",
  "- show_list_card: short visible lists, capped to the most useful items.",
  "- show_progress_card: ordered steps with one active step.",
  "- show_note_card: a short note that should stay visible, not a duplicate of chat history.",
  "- show_artifact_card: a file, image, HTML, or other artifact preview backed by a real path or artifact reference.",
  "- show_dynamic_widget: specialized widgets such as html, metric_strip, timeline, dag_flow, chart, topic_outline, or slide_deck.",
  "- remove_widget: hide obsolete widgets when they no longer help the user.",
  "",
  "Do not invent widget ids or widget types outside this catalog unless the tool explicitly supports them. Reuse stable ids so later turns update the same visual state instead of adding more cards.",
  "",
  "## Memo Widget",
  "",
  "The first voice widget should normally be a memo-style widget. It records the user's evolving intent without pretending the task is ready.",
  "",
  "Use update_voice_memo first for multi-turn requirement gathering. It writes the session memo to a local TOML file and renders the stable voice-memo widget. Do not hand-roll a separate note card for the same purpose.",
  "",
  "Memo lifecycle:",
  "- listening: user is still speaking or adding context.",
  "- clarifying: Agent needs missing details.",
  "- ready: enough information is available and the Agent should ask for confirmation.",
  "- executing: execution has started with a real tool/run id.",
  "- done: task finished or memo can be minimized.",
  "",
  "Memo update contract:",
  "- Treat update_voice_memo input as the whole current memo, not an append-only log.",
  "- Preserve useful previous facts and questions when the user adds new context.",
  "- Mark a todo as done when the user answers it; do not keep asking that item.",
  "- Keep at most the most important open questions and todos visible.",
  "- If the task is not ready, keep ready_to_execute false and ask the next missing question in next_action.",
  "- When all critical questions are answered, set status ready, set ready_to_execute true, and ask for confirmation before execution.",
  "",
  "## File-backed Memo Direction",
  "",
  "update_voice_memo is file-backed. It stores the current memo in a local TOML file and renders that file's structured content into the widget. The Agent should update and check off todo items instead of appending endlessly.",
  "",
  "For non-memo persisted widgets, write TOML through write_widget_file. Valid TOML refreshes the page; invalid TOML returns structured validation errors and must be corrected before the UI changes. Supported V1 widget types are memo, task_draft, progress_status, checklist, artifact_ref, and timeline.",
  "",
  "## Hard Product Rules",
  "",
  "- Do not create decorative cards.",
  "- Do not create duplicate low-information widgets.",
  "- Do not create more than two widgets in one turn.",
  "- Do not create manager-run style execution state unless there is a real run id or explicit blocker.",
  "- Do not put long markdown lists into spoken text; use a memo/list/progress widget instead.",
].join("\n");

const BUILTIN_VOICE_SYSTEM_CONTRACT = [
  "# Voice Surface Contract",
  "",
  "You are the HomeRail Main Agent speaking through the voice surface.",
  "",
  "Core responsibilities:",
  "",
  "- Treat voice as an input/output adapter for the same Main Agent, not as a relay agent, draft-only assistant, or keyword router.",
  "- Preserve the user's intent and multi-turn context. If the user is still describing the task, keep collecting requirements instead of pretending to execute.",
  "- Use real Manager tools for state-changing work. Never claim that a DAG, run, file change, or external action happened unless a tool result proves it.",
  "- Use commentary for short execution progress. Persist final answers and commentary as separate channels.",
  "- Keep final spoken text short, conversational, and in Chinese unless the user asks otherwise.",
  "- Put long status, checklists, evidence, task drafts, and artifacts into tool-created widgets instead of the spoken reply.",
  "- Generated UI must come from voice tools and the widget protocol. Do not infer business intent with hard-coded keywords or create UI from backend regex branches.",
  "- Voice-specific settings are ASR, TTS, playback, VAD, controller, and UI preferences. Main Agent runtime selection comes from the shared Main Agent config.",
  "",
  "When unsure, ask one concise clarification question or record the current memo state. Do not invent task progress.",
].join("\n");

export interface VoiceUiRules {
  prompt: string;
  sources: string[];
  hash: string;
}

export interface VoiceSystemContract {
  prompt: string;
  source: string;
}

function readTextIfPresent(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function userVoiceRulesPath(): string {
  return getUserVoiceRulesPath();
}

export function getUserVoiceRulesPath(): string {
  const explicit = process.env.HOMERAIL_VOICE_UI_RULES_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(getHomerailHome(), "asset", "voice-agent", "ui-rules.md");
}

export function loadVoiceUiRules(): VoiceUiRules {
  const sources = ["baseline:builtin", "skill:builtin"];
  const chunks = [
    "## Baseline Voice UI Rules",
    BUILTIN_VOICE_UI_PRINCIPLES,
    "## Voice Generative UI Skill",
    BUILTIN_VOICE_GENERATIVE_UI_SKILL,
  ];

  const userPath = userVoiceRulesPath();
  const userRules = readTextIfPresent(userPath);
  if (userRules) {
    sources.push(`user:${userPath}`);
    chunks.push(
      "## User Voice UI Rules",
      "The following user rules are editable assets. Apply them as a voice-surface preference overlay unless they conflict with safety or truthful execution.",
      userRules,
    );
  } else {
    sources.push(`user:missing:${userPath}`);
  }

  const prompt = chunks.join("\n\n");
  const hash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  return { prompt, sources, hash };
}

export function _loadVoiceUiRulesForTest(): VoiceUiRules {
  return loadVoiceUiRules();
}

export function loadVoiceSystemContract(): VoiceSystemContract {
  return { prompt: BUILTIN_VOICE_SYSTEM_CONTRACT, source: "system:builtin" };
}

export function _loadVoiceSystemContractForTest(): VoiceSystemContract {
  return loadVoiceSystemContract();
}

function systemPrompt(
  config: ManagerAgentRuntimeConfig,
  responseMode: "chat" | "voice" = "chat",
  voiceUiRules?: VoiceUiRules,
  voiceSystemContract?: VoiceSystemContract,
  skills?: ManagerAgentPromptSkill[],
): string {
  return buildManagerAgentSystemPrompt({
    responseMode,
    runtime: {
      placement: "host",
      provider: config.provider_name || "host-codex",
      model: config.model || "unknown",
    },
    voiceUiRules: responseMode === "voice" ? voiceUiRules ?? loadVoiceUiRules() : undefined,
    voiceSystem: responseMode === "voice" ? voiceSystemContract ?? loadVoiceSystemContract() : undefined,
    skills,
  });
}

export function _systemPromptForTest(
  config: ManagerAgentRuntimeConfig,
  responseMode: "chat" | "voice" = "chat",
  voiceUiRules?: VoiceUiRules,
  voiceSystemContract?: VoiceSystemContract,
  skills?: ManagerAgentPromptSkill[],
): string {
  return systemPrompt(config, responseMode, voiceUiRules, voiceSystemContract, skills);
}

function buildPrompt(
  history: HostCodexManagerAgentInput["history"],
  message: string,
  continueChat: boolean,
): string {
  const normalizedHistory = continueChat && Array.isArray(history)
    ? history
      .slice(-12)
      .filter((item) => {
        const role = item.role === "user" || item.role === "assistant" ? item.role : "";
        return role && typeof item.content === "string" && item.content.trim();
      })
      .map((item) => `${item.role}: ${item.content}`)
      .join("\n")
    : "";
  return normalizedHistory
    ? `Conversation history:\n${normalizedHistory}\n\nNew user message:\n${message}`
    : message;
}

function toolCallCommentary(name: string): string | undefined {
  switch (name) {
    case "list_orchestrations":
      return "正在查看可用的 DAG 编排。";
    case "list_skills":
    case "read_skill":
      return "正在加载 HomeRail Skill。";
    case "list_dag_patterns":
    case "get_dag_pattern":
      return "正在选择合适的 DAG 模式。";
    case "instantiate_dag_pattern":
      return "正在生成并同步 DAG 模式。";
    case "get_dag_schema":
      return "正在读取 DAG 规范。";
    case "validate_dag_workflow":
      return "正在验证 DAG 定义。";
    case "sync_dag_workflow":
      return "正在保存 DAG 定义。";
    case "create_and_run":
      return "正在启动 DAG。";
    case "invoke_run":
      return "正在推进 DAG。";
    case "get_run_status":
      return "正在查询 DAG 状态。";
    case "create_change":
      return "正在创建变更记录。";
    case "run_shell_command":
      return "正在做只读检查。";
    default:
      return undefined;
  }
}

function compactDeltas(parts: string[]): string {
  return parts.join("").trim();
}

export function _compactDeltasForTest(parts: string[]): string {
  return compactDeltas(parts);
}

function buildHostCodexManagerAgentResult(
  input: HostCodexManagerAgentInput,
  state: {
    workspace: string;
    createdRunIds: string[];
    finalNotes: string[];
    objectiveToolCalls: Array<{ name: string; success: boolean; error?: string }>;
    voiceSurface: VoiceSurfaceState;
  },
  responseMode: "chat" | "voice",
  voiceUiRules: VoiceUiRules | undefined,
  voiceSystemContract: { prompt: string; source: string } | undefined,
  texts: string[],
  commentaryTexts: string[],
  toolCommentaryTexts: string[],
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }>,
): Record<string, unknown> {
  const config = input.agent_config;
  const finalText = state.finalNotes.at(-1) || compactDeltas(texts) || "Manager Agent turn completed.";
  const commentary = [
    ...toolCommentaryTexts,
    ...state.voiceSurface.commentaryTexts,
    ...(compactDeltas(commentaryTexts) ? [compactDeltas(commentaryTexts)] : []),
  ];
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
    session_id: input.session_id || `host-codex-${randomUUID()}`,
    run_id: state.createdRunIds.at(-1) ?? null,
    run_ids: state.createdRunIds,
    objective: {
      required: false,
      tool_calls: state.objectiveToolCalls,
      satisfied: state.objectiveToolCalls.length === 0 || state.objectiveToolCalls.some((item) => item.success),
    },
    effective_config: {
      harness: "host_codex",
      response_mode: responseMode,
      provider: config.provider_name || null,
      model: config.model || null,
      reasoning_effort: config.reasoning_effort || null,
      service_tier: config.service_tier,
      workspace: state.workspace,
      voice_system_source: voiceSystemContract?.source ?? null,
      voice_system_hash: voiceSystemContract ? createHash("sha256").update(voiceSystemContract.prompt).digest("hex").slice(0, 16) : null,
      voice_ui_rules_hash: voiceUiRules?.hash ?? null,
      voice_ui_rules_sources: voiceUiRules?.sources ?? [],
    },
    tool_calls: toolCalls,
    tool_results: toolResults,
    commentary_texts: commentary,
    project_id: input.project_id ?? config.project_id ?? null,
    worker_id: "host-codex",
    container_name: null,
  };
}

async function* runHostCodexManagerAgentTurnEvents(
  input: HostCodexManagerAgentInput,
): AsyncGenerator<HostCodexManagerAgentStreamEvent> {
  const message = input.message.trim();
  if (!message) throw new Error("Missing required field: message");
  const config = input.agent_config;
  const restUrl = managerRestUrl(input.managerRestUrl);
  const workspace = workspaceFromConfig(config);
  const state = {
    restUrl,
    workspace,
    projectId: input.project_id ?? config.project_id,
    sessionId: input.voice_session_id ?? input.session_id,
    createdRunIds: [] as string[],
    finalNotes: [] as string[],
    objectiveToolCalls: [] as Array<{ name: string; success: boolean; error?: string }>,
    voiceSurface: emptyVoiceSurface(),
  };
  const responseMode = input.response_mode ?? "chat";
  const voiceUiRules = responseMode === "voice" ? input.voice_ui_rules ?? loadVoiceUiRules() : undefined;
  const voiceSystemContract = responseMode === "voice" ? loadVoiceSystemContract() : undefined;
  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> = [];
  const texts: string[] = [];
  const commentaryTexts: string[] = [];
  const toolCommentaryTexts: string[] = [];
  let emittedVoiceSurfaceCommentaryCount = 0;
  const abortController = new AbortController();
  const turnTimeoutMs = managerAgentTurnTimeoutMs();
  const timeout = turnTimeoutMs > 0 ? setTimeout(() => abortController.abort(), turnTimeoutMs) : undefined;
  timeout?.unref?.();
  const adapter = new HostCodexAppServerAdapter();
  try {
    for await (const event of adapter.run(
      buildPrompt(input.history, message, input.continue_chat !== false),
      createManagerTools(state, responseMode),
      {
        systemPrompt: systemPrompt(config, responseMode, voiceUiRules, voiceSystemContract, input.manager_skills),
        provider: config.provider_name || undefined,
        model: config.model || "codex",
        apiKey: config.api_key || "",
        baseUrl: config.base_url || "",
        workspace,
        abortSignal: abortController.signal,
        reasoning_effort: config.reasoning_effort,
        service_tier: config.service_tier,
      },
    )) {
      if (event.type === "text") {
        texts.push(event.text);
      } else if (event.type === "thinking") {
        commentaryTexts.push(event.text);
      } else if (event.type === "tool_use") {
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
        const commentary = toolCallCommentary(event.name);
        if (commentary && !toolCommentaryTexts.includes(commentary)) {
          toolCommentaryTexts.push(commentary);
          yield { type: "commentary", text: commentary, source: "tool" };
        }
      } else if (event.type === "tool_result") {
        toolResults.push({ tool_use_id: event.tool_use_id, content: event.content, is_error: event.is_error });
        const newSurfaceCommentary = state.voiceSurface.commentaryTexts.slice(emittedVoiceSurfaceCommentaryCount);
        emittedVoiceSurfaceCommentaryCount = state.voiceSurface.commentaryTexts.length;
        for (const text of newSurfaceCommentary) {
          yield { type: "commentary", text, source: "voice_surface" };
        }
      } else if (event.type === "error") {
        texts.push(`[ERROR] ${event.message}`);
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const remainingSurfaceCommentary = state.voiceSurface.commentaryTexts.slice(emittedVoiceSurfaceCommentaryCount);
  for (const text of remainingSurfaceCommentary) {
    yield { type: "commentary", text, source: "voice_surface" };
  }
  yield {
    type: "result",
    result: buildHostCodexManagerAgentResult(
      input,
      state,
      responseMode,
      voiceUiRules,
      voiceSystemContract,
      texts,
      commentaryTexts,
      toolCommentaryTexts,
      toolCalls,
      toolResults,
    ),
  };
}

export async function* runHostCodexManagerAgentTurnStream(
  input: HostCodexManagerAgentInput,
): AsyncGenerator<HostCodexManagerAgentStreamEvent> {
  if (hostStreamRunnerOverride) {
    yield* hostStreamRunnerOverride(input);
    return;
  }
  if (hostRunnerOverride) {
    yield { type: "result", result: await hostRunnerOverride(input) };
    return;
  }
  yield* runHostCodexManagerAgentTurnEvents(input);
}

export async function runHostCodexManagerAgentTurn(
  input: HostCodexManagerAgentInput,
): Promise<Record<string, unknown>> {
  if (hostRunnerOverride) return hostRunnerOverride(input);
  let result: Record<string, unknown> | undefined;
  for await (const event of runHostCodexManagerAgentTurnEvents(input)) {
    if (event.type === "result") result = event.result;
  }
  if (!result) throw new Error("Host Codex Manager Agent turn completed without a result");
  return result;
}

class HostCodexAppServerAdapter {
  private process: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private notifications: Array<Record<string, unknown>> = [];
  private notifyWaiters: Array<() => void> = [];
  private codexBin: string;
  private codexNeedsShell = false;

  constructor(codexBin?: string) {
    this.codexBin = codexBin ?? process.env.HOMERAIL_CODEX_BIN ?? process.env.CODEX_BIN_PATH ?? DEFAULT_CODEX_BIN;
  }

  async *run(
    prompt: string,
    tools: ToolDefinition[],
    context: AgentRunContext,
  ): AsyncIterable<AgentEvent> {
    const maxIterations = context.maxIterations ?? 10;
    const toolMap = new Map<string, ToolDefinition>();
    for (const t of tools) toolMap.set(t.name, t);
    try {
      await this.validateBinary();
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      yield { type: "done" };
      return;
    }
    try {
      this.process = spawn(this.codexBin, _buildCodexAppServerArgsForTest(), {
        stdio: ["pipe", "pipe", "pipe"],
        env: this.buildEnv(context),
        cwd: context.workspace ?? process.cwd(),
        shell: this.codexNeedsShell,
        windowsHide: true,
      });
      this.setupReadline();
    } catch (err) {
      yield { type: "error", message: `Failed to start codex app-server: ${err}` };
      yield { type: "done" };
      return;
    }

    const abortHandler = context.abortSignal ? () => this.sendNotification("cancel", {}) : null;
    if (abortHandler && context.abortSignal) {
      context.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
    let stderr = "";
    this.process.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    this.process.on("error", (err) => {
      this.rejectAllPending(`Process error: ${err.message}`);
    });
    this.process.on("exit", (code) => {
      this.rejectAllPending(`Process exited with code ${code}`);
    });

    try {
      yield this.debugEvent("appserver_start", {
        codex_bin: this.codexBin,
        model: context.model,
        workspace: context.workspace ?? process.cwd(),
        tool_count: tools.length,
        home: os.homedir(),
        service_tier: context.service_tier ?? null,
      });
      const initResult = await this.sendRequest("initialize", {
        clientInfo: {
          name: CLIENT_NAME,
          title: CLIENT_TITLE,
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });
      yield this.debugEvent("appserver_initialized", this.redactSecrets(initResult));
      const dynamicTools = this.buildDynamicToolSpecs(tools);
      const cwd = context.workspace ?? process.cwd();
      const threadResult = await this.sendRequest("thread/start", _buildCodexThreadStartParamsForTest({
        systemPrompt: context.systemPrompt,
        cwd,
        model: context.model,
        provider: context.provider,
        serviceTier: context.service_tier,
        sandbox: process.env.HOMERAIL_CODEX_MANAGER_SANDBOX || "workspace-write",
        dynamicTools,
        reasoningEffort: context.reasoning_effort,
      }));
      const threadId =
        (threadResult.thread_id as string | undefined) ??
        ((threadResult.thread as Record<string, unknown> | undefined)?.id as string | undefined);
      if (!threadId) throw new Error("thread/start response did not include a thread id");
      yield this.debugEvent("thread_created", { thread_id: threadId });

      let iteration = 0;
      let turnComplete = false;
      while (iteration < maxIterations && !turnComplete && !context.abortSignal?.aborted) {
        iteration++;
        const turnResult = await this.sendRequest("turn/start", _buildCodexTurnStartParamsForTest({
          threadId,
          prompt: iteration === 1 ? prompt : undefined,
          cwd,
          model: context.model,
          reasoningEffort: context.reasoning_effort,
          serviceTier: context.service_tier,
        }));
        const turnId =
          (turnResult.turn_id as string | undefined) ??
          ((turnResult.turn as Record<string, unknown> | undefined)?.id as string | undefined) ??
          "";
        yield this.debugEvent("turn_started", { turn_id: turnId, iteration });

        turnComplete = false;
        while (!turnComplete) {
          let notification: Record<string, unknown>;
          try {
            notification = await this.waitForNotification(120_000);
          } catch {
            yield { type: "error", message: "Timeout waiting for codex app-server notification" };
            return;
          }
          const method = notification.method as string;
          const requestId = notification.id as number | undefined;
          const payload = notification.params as Record<string, unknown> | undefined;
          const events = this.mapNotification(method, payload);
          for (const event of events) {
            yield event;
            if (event.type === "tool_use" && toolMap.has(event.name)) {
              const def = toolMap.get(event.name)!;
              let content: string;
              let isError = false;
              try {
                const result = await def.handler(event.input);
                content = result.content.map((b) => b.text ?? "").join("") || JSON.stringify(result);
                isError = result.is_error === true;
              } catch (toolErr) {
                content = `Tool ${event.name} threw: ${toolErr}`;
                isError = true;
              }
              yield { type: "tool_result", tool_use_id: event.id, content, is_error: isError };
              if (requestId !== undefined && method === "item/tool/call") {
                this.sendResponse(requestId, {
                  contentItems: [{ type: "inputText", text: content }],
                  success: !isError,
                });
              } else {
                this.sendNotification("tool_result", {
                  turn_id: turnId,
                  tool_use_id: event.id,
                  content: [{ type: "text", text: content }],
                  is_error: isError,
                });
              }
            }
          }
          if (method === "turn/completed") turnComplete = true;
          if (method === "error") return;
        }
        yield this.debugEvent("turn_completed", { turn_id: turnId, iteration });
      }
      if (iteration >= maxIterations) {
        yield { type: "error", message: `Exceeded max iterations (${maxIterations})` };
      }
      try {
        await this.sendRequest("thread/unsubscribe", { threadId });
      } catch {
        // Best-effort cleanup.
      }
    } catch (err) {
      yield { type: "error", message: `Codex app-server error: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      if (abortHandler && context.abortSignal) {
        context.abortSignal.removeEventListener("abort", abortHandler);
      }
      yield this.debugEvent("appserver_done", { stderr_tail: stderr.slice(-2000) || null });
      this.shutdown();
    }
    yield { type: "done" };
  }

  private buildEnv(context: AgentRunContext): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    if (context.apiKey) env.OPENAI_API_KEY = context.apiKey;
    if (context.baseUrl) env.OPENAI_BASE_URL = context.baseUrl;
    return env;
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.process?.stdin) throw new Error("App-server process not running");
    const id = ++this.requestId;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.process.stdin.write(`${JSON.stringify(request)}\n`);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request ${method} (id=${id}) timed out`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin) return;
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.process.stdin.write(`${JSON.stringify(notification)}\n`);
  }

  private sendResponse(id: number, result: Record<string, unknown>): void {
    if (!this.process?.stdin) return;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private setupReadline(): void {
    if (!this.process?.stdout) return;
    this.rl = createInterface({ input: this.process.stdout });
    this.rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: JsonRpcResponse | JsonRpcNotification;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification;
      } catch {
        return;
      }
      if ("method" in parsed) {
        this.notifications.push(parsed as unknown as Record<string, unknown>);
        const waiters = this.notifyWaiters.splice(0);
        for (const waiter of waiters) waiter();
      } else if ("id" in parsed && typeof parsed.id === "number") {
        const pending = this.pending.get(parsed.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(parsed.id);
        if (parsed.error) {
          pending.reject(new Error(`JSON-RPC error ${parsed.error.code}: ${parsed.error.message}`));
        } else {
          pending.resolve(parsed.result ?? {});
        }
      }
    });
  }

  private waitForNotification(timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.notifications.length > 0) return Promise.resolve(this.notifications.shift()!);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.notifyWaiters.indexOf(waiter);
        if (idx >= 0) this.notifyWaiters.splice(idx, 1);
        reject(new Error("Notification wait timed out"));
      }, timeoutMs);
      const waiter = () => {
        clearTimeout(timer);
        if (this.notifications.length > 0) resolve(this.notifications.shift()!);
      };
      this.notifyWaiters.push(waiter);
    });
  }

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private shutdown(): void {
    try {
      this.rl?.close();
    } catch {
      // Ignore.
    }
    this.rl = null;
    try {
      this.process?.stdin?.end();
      this.process?.kill("SIGTERM");
    } catch {
      // Ignore.
    }
    this.process = null;
    this.rejectAllPending("Adapter shutting down");
  }

  private mapNotification(method: string, payload: Record<string, unknown> | undefined): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (!payload) return events;
    switch (method) {
      case "item/agentMessage/delta": {
        const delta = payload.delta as string | undefined;
        if (delta) events.push({ type: "text", text: delta });
        break;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = (payload.delta as string) ?? (payload.text as string) ?? "";
        if (delta) events.push({ type: "thinking", text: delta });
        break;
      }
      case "item/started": {
        const item = (payload.item as Record<string, unknown>) ?? payload;
        const root = (item.root as Record<string, unknown>) ?? item;
        const itemType = root.type as string;
        if (itemType === "commandExecution") {
          events.push({
            type: "tool_use",
            id: (root.id as string) ?? "",
            name: "bash",
            input: { command: (root.command as string) ?? "" },
          });
        } else if (itemType === "mcpToolCall") {
          events.push({
            type: "tool_use",
            id: (root.id as string) ?? "",
            name: (root.tool as string) ?? "",
            input: (root.arguments as Record<string, unknown>) ?? {},
          });
        }
        break;
      }
      case "item/completed": {
        const item = (payload.item as Record<string, unknown>) ?? payload;
        const root = (item.root as Record<string, unknown>) ?? item;
        const itemType = root.type as string;
        if (itemType === "commandExecution") {
          const exitCode = (root.exitCode ?? root.exit_code) as number | null | undefined;
          events.push({
            type: "tool_result",
            tool_use_id: (root.id as string) ?? "",
            content: ((root.aggregatedOutput ?? root.aggregated_output) as string | null | undefined) ?? "",
            is_error: exitCode != null && exitCode !== 0,
          });
        } else if (itemType === "mcpToolCall") {
          const error = root.error as Record<string, unknown> | null | undefined;
          const result = root.result as Record<string, unknown> | null | undefined;
          let content = "";
          if (error) {
            content = (error.message as string) ?? String(error);
          } else if (result) {
            const contentBlocks = result.content as Array<{ text?: string }> | undefined;
            content = contentBlocks?.map((b) => b.text ?? "").join("\n") ?? "";
          }
          events.push({
            type: "tool_result",
            tool_use_id: (root.id as string) ?? "",
            content,
            is_error: Boolean(error),
          });
        }
        break;
      }
      case "item/tool/call": {
        events.push({
          type: "tool_use",
          id: (payload.callId as string) ?? "",
          name: (payload.tool as string) ?? "",
          input: (payload.arguments as Record<string, unknown>) ?? {},
        });
        break;
      }
      case "error": {
        const message = typeof payload.message === "string" && payload.message.trim()
          ? payload.message
          : `codex app-server error: ${short(payload, 1000)}`;
        events.push({ type: "error", message });
        break;
      }
      case "turn/completed": {
        events.push({ type: "turn_complete" });
        break;
      }
    }
    return events;
  }

  private debugEvent(message: string, data?: Record<string, unknown>): AgentEvent {
    return {
      type: "debug",
      source: "host-codex-appserver",
      message,
      data: this.redactSecrets(data ?? {}),
    };
  }

  private redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.some((secretKey) => k.toLowerCase().includes(secretKey.toLowerCase()))) {
        out[k] = "[REDACTED]";
      } else if (typeof v === "string") {
        out[k] = this.redactString(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  private redactString(s: string): string {
    return s
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]")
      .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]");
  }

  private async validateBinary(): Promise<void> {
    const resolved = resolveCodexBinary(this.codexBin);
    if (resolved) {
      this.codexBin = resolved.command;
      this.codexNeedsShell = resolved.needsShell;
      return;
    }
    throw new Error(codexBinaryNotFoundMessage(this.codexBin));
  }

  private buildDynamicToolSpecs(tools: ToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    }));
  }
}

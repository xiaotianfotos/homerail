import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { getDataRoot } from "../config/env.js";
import { encodeJson, getDb, parseJsonRow } from "../persistence/db.js";
import { readManagerAgentConfig } from "../persistence/manager-agent-config.js";
import { getProject } from "../persistence/projects-changes.js";
import { normalizeStatus } from "../persistence/status.js";
import {
  resolveManagerAgentConfig,
  type ManagerAgentContainerOptions,
} from "./manager-agent-container.js";
import {
  composeVoiceUiRules,
  getUserVoiceRulesPath,
  loadUserVoiceUiRulesOverlay,
  loadVoiceUiRules,
  writeVoiceMemoWidget,
  type VoiceUiRules,
} from "./host-codex-manager-agent.js";
import {
  ManagerAgentRuntimeError,
  managerAgentRuntimePlacement,
  runManagerAgentTurn,
  runManagerAgentTurnStream,
  type RunManagerAgentTurnInput,
} from "./manager-agent-runtime.js";
import {
  ManagerAgentConfigValidationError,
  ensurePreferredManagerAgentConfig,
  validateAndSaveManagerAgentConfig,
  type ManagerAgentConfigRoutesOptions,
} from "./manager-agent-config.js";
import { resolveCodexBinary, runCodexCommandSync } from "./codex-binary.js";
import {
  managerAgentRuntimePlacementForHarness,
  managerAgentPluginOwnedLegacyWidgetType,
  normalizeManagerAgentHarness,
  type GenerativeUiNodeV1,
  type HomerailPluginTurnContextV1,
} from "homerail-protocol";
import {
  listWidgetFileTypes,
  readWidgetFile,
  removeWidgetFile,
  validateWidgetToml,
  widgetTomlExample,
  writeWidgetFile,
  type WidgetFileType,
} from "../widgets/widget-file-protocol.js";
import {
  completeTurn,
  getTurnStatus,
  registerTurn,
  withSessionLock,
} from "./voice-session-registry.js";
import {
  resolveConfiguredGenerativeUiMode,
  resolveConfiguredGenerativeUiModeDetails,
  resolveSessionGenerativeUiMode,
  type GenerativeUiMode,
} from "../generative-ui/mode.js";
import {
  generativeUiShadowService,
  persistentGenerativeUiDocumentService,
  type GenerativeUiShadowSnapshotV1,
} from "../generative-ui/shadow-service.js";
import {
  applyVoiceCanonicalProjectionPatch,
  VoiceCanonicalProjectionConflictError,
  type VoiceCanonicalProjectionPatch,
} from "../generative-ui/canonical-voice-service.js";
import { buildGenerativeUiCanvasContext } from "../generative-ui/canvas-context.js";
import { acceptPluginToolExecution } from "../plugins/execution-broker.js";
import {
  publishVoiceArtifact,
  resolveVoiceArtifact,
} from "./voice-artifacts.js";
import {
  assembleLegacyWidgetReservations,
  assemblePluginTurnContext,
} from "../plugins/context-assembler.js";

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

/** Distinguish 404 (workspace not found) from 400 (bad request) in lock-scoped flows. */
class HttpNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpNotFoundError";
  }
}

class HttpBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpBadRequestError";
  }
}

type VoicePriority = "low" | "normal" | "high";

interface VoiceWidget {
  id: string;
  type: string;
  title: string;
  body: string;
  priority: VoicePriority;
  status?: string | null;
  items: string[];
  steps: string[];
  active_step?: number | null;
  data: Record<string, unknown>;
}

interface VoiceUiRulesSnapshot {
  format_version?: 1;
  content_kind?: "user_overlay";
  hash: string;
  sources: string[];
  prompt_path: string;
  created_at: string;
}

interface VoiceWorkspace {
  session_id: string;
  mode: "voice";
  generative_ui_mode?: GenerativeUiMode;
  generative_ui_shadow_released?: boolean;
  generative_ui_canonical_pending?: VoiceCanonicalProjectionPatch;
  project_id?: string | null;
  project_workspace_path?: string | null;
  voice_assets_dir?: string | null;
  voice_ui_rules?: VoiceUiRulesSnapshot | null;
  manager_session_id?: string | null;
  manager_run_id?: string | null;
  manager_run_ids?: string[];
  orchestrator_session_id?: string | null;
  source_issue_number?: number | null;
  source_issue_url?: string | null;
  source_issue_title?: string | null;
  session_title?: string | null;
  session_slate: string;
  active_objective?: string | null;
  task_draft?: {
    title: string;
    request: string;
    acceptance: string[];
    constraints: string[];
    status: "draft" | "clarifying" | "needs_confirmation" | "submitted";
  } | null;
  pending_confirmations: Array<{ id: string; kind: "submit_task" | "memory_write"; summary: string }>;
  memory_refs: Array<{ id: string; title: string; summary: string; source: string }>;
  conversation: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    text: string;
    spoken_text?: string;
    created_at: string;
    channel?: "final" | "commentary";
    kind?: "message" | "error";
  }>;
  debug_events: Array<{ id: string; level: "debug" | "info" | "warning" | "error"; code: string; message: string; created_at: string }>;
  progress_brief: { status: string; short_text: string; updated_at: string };
  widgets: VoiceWidget[];
  plugin_nodes?: GenerativeUiNodeV1[];
  ui_events: Array<Record<string, unknown>>;
  codex_monitor_status?: "idle" | "running" | "done" | "failed";
  codex_monitor_run_id?: string | null;
  ended_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface VoiceTurnResult {
  spoken_text: string;
  suggested_action: "confirm" | null;
  commentary_texts?: string[];
}

interface ManagerAgentHandoffResult extends VoiceTurnResult {
  manager: Record<string, unknown>;
  manager_status: Record<string, unknown>;
}

interface RealtimeSpeechEvent {
  id: string;
  channel: "commentary" | "final";
  text: string;
}

interface ManagerAgentRealtimeHooks {
  onSpeech?: (event: RealtimeSpeechEvent) => void;
  streamedCommentaryTexts?: Set<string>;
}

const DEFAULT_VOICE_AGENT_CONFIG = {
  agent_type: "voice_agent",
  harness: "claude_agent_sdk",
  llm_setting_id: null,
  provider_name: null,
  model_name: null,
  reasoning_effort: "low",
  system_prompt: "",
  enabled_tools: [
    "update_task_draft",
    "submit_task",
    "cancel_task",
    "get_manager_status",
    "show_status_card",
    "show_list_card",
    "show_progress_card",
    "show_note_card",
    "show_artifact_card",
    "show_dynamic_widget",
    "list_widgets",
    "set_widget_state",
    "remove_widget",
  ],
  session_policy: {
    persist_conversation: true,
    max_conversation_messages: 40,
    persist_sdk_client: false,
    repair_attempts: 1,
    codex_loop_mode: "structured",
  },
};

const USER_VOICE_UI_RULES_TEMPLATE = [
  "# Voice Agent UI Rules",
  "",
  "这些规则会在新 voice session 创建时与内置基准规则合并并生成快照。",
  "只写界面和交互偏好，不要写 API key、token、密码或临时任务内容。",
  "",
  "## Listening",
  "- 优先使用 voice-memo 记录用户连续表达的需求。",
  "- 用户还没说清范围、交付形式或是否执行前，先记录和确认，不要急着启动任务。",
  "- 用户补充新信息时，更新已有 memo，并把已完成的 todo 标记完成。",
  "",
  "## Spoken Reply",
  "- 口播保持一两句中文短回复。",
  "- 长清单、证据、路径和执行状态放进 widget，不直接念出来。",
  "",
  "## Widgets",
  "- 简单聊天不要创建执行状态卡。",
  "- 需要记录需求时优先更新 voice-memo；只有真实 run 或阻塞才展示执行态势。",
  "",
].join("\n");

const LEGACY_PROGRAMMATIC_WIDGET_IDS = new Set([
  "manager-status",
  "manager-progress",
  "dag-progress",
  "manager-run",
  "manager-agent-blocker",
]);

function json(res: http.ServerResponse, status: number, body: BaseResponse) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function ok(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 200, { success: true, message, data });
}

function created(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 201, { success: true, message, data });
}

function badRequest(res: http.ServerResponse, message: string) {
  json(res, 400, { success: false, message, error: message });
}

function notFound(res: http.ServerResponse, message: string) {
  json(res, 404, { success: false, message, error: message });
}

function serverError(res: http.ServerResponse, message: string) {
  json(res, 500, { success: false, message, error: message });
}

function now(): string {
  return new Date().toISOString();
}

function generateId(prefix = ""): string {
  return `${prefix}${crypto.randomBytes(10).toString("hex")}`;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("invalid voice session id");
  return value;
}

function safeAssetSegment(value?: string | null): string {
  const raw = String(value || "_global").trim() || "_global";
  const safe = raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96);
  return safe || "_global";
}

function voiceAssetsDir(projectId?: string | null): string {
  return path.join(getDataRoot(), "voice-agent-projects", safeAssetSegment(projectId), "assets");
}

function voiceUiRulesSnapshotPath(projectId: string | null | undefined, sessionId: string): string {
  return path.join(voiceAssetsDir(projectId), "ui-rules", `${safeId(sessionId)}.md`);
}

function createVoiceUiRulesSnapshot(sessionId: string, projectId?: string | null): VoiceUiRulesSnapshot {
  const overlay = loadUserVoiceUiRulesOverlay();
  const rules = composeVoiceUiRules(overlay.prompt, overlay.sources);
  const promptPath = voiceUiRulesSnapshotPath(projectId, sessionId);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, overlay.prompt, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(promptPath, 0o600);
  } catch {
    // Best effort only; some mounted filesystems ignore chmod.
  }
  return {
    format_version: 1,
    content_kind: "user_overlay",
    hash: rules.hash,
    sources: rules.sources,
    prompt_path: promptPath,
    created_at: now(),
  };
}

function userOverlayFromLegacyVoiceRulesSnapshot(content: string): string {
  const marker = "## User Voice UI Rules";
  const index = content.indexOf(marker);
  if (index < 0) {
    // Recovery for an interrupted migration: the file may already contain the
    // extracted overlay while the workspace metadata still has the old shape.
    // A real old full snapshot always carries the baseline heading.
    return content.includes("## Baseline Voice UI Rules") ? "" : content.trim();
  }
  const lines = content.slice(index + marker.length).trim().split("\n");
  if (lines[0]?.startsWith("The following user rules are editable assets.")) lines.shift();
  return lines.join("\n").trim();
}

function ensureWorkspaceVoiceUiRules(workspace: VoiceWorkspace): VoiceUiRules {
  if (!workspace.voice_ui_rules || !fs.existsSync(workspace.voice_ui_rules.prompt_path)) {
    workspace.voice_ui_rules = createVoiceUiRulesSnapshot(workspace.session_id, workspace.project_id);
  }
  let overlay = fs.readFileSync(workspace.voice_ui_rules.prompt_path, "utf8");
  if (
    workspace.voice_ui_rules.format_version !== 1
    || workspace.voice_ui_rules.content_kind !== "user_overlay"
  ) {
    overlay = userOverlayFromLegacyVoiceRulesSnapshot(overlay);
    fs.writeFileSync(workspace.voice_ui_rules.prompt_path, overlay, { encoding: "utf8", mode: 0o600 });
    const migrated = composeVoiceUiRules(
      overlay,
      workspace.voice_ui_rules.sources.filter((source) => source.startsWith("user:")),
    );
    workspace.voice_ui_rules = {
      ...workspace.voice_ui_rules,
      format_version: 1,
      content_kind: "user_overlay",
      hash: migrated.hash,
      sources: migrated.sources,
    };
  }
  const userSources = workspace.voice_ui_rules.sources.filter((source) => source.startsWith("user:"));
  return composeVoiceUiRules(overlay, userSources);
}

function readVoiceUiRulesAsset(createTemplate = false): Record<string, unknown> {
  const file = getUserVoiceRulesPath();
  if (createTemplate && !fs.existsSync(file)) {
    writeVoiceUiRulesAsset(USER_VOICE_UI_RULES_TEMPLATE);
  }
  const exists = fs.existsSync(file);
  const content = exists ? fs.readFileSync(file, "utf8") : "";
  const stat = exists ? fs.statSync(file) : null;
  const rules = loadVoiceUiRules();
  return {
    path: file,
    exists,
    content,
    template: USER_VOICE_UI_RULES_TEMPLATE,
    updated_at: stat ? stat.mtime.toISOString() : null,
    effective_hash: rules.hash,
    effective_sources: rules.sources,
  };
}

function writeVoiceUiRulesAsset(content: string): void {
  if (Buffer.byteLength(content, "utf8") > 40_000) {
    throw new Error("Voice UI rules file is too large; keep it under 40 KB.");
  }
  const file = getUserVoiceRulesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort only; some mounted filesystems ignore chmod.
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        const parsed = data ? JSON.parse(data) : {};
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function voiceCompatConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...DEFAULT_VOICE_AGENT_CONFIG, ...config };
  const mode = resolveConfiguredGenerativeUiModeDetails(result.generative_ui_mode);
  return {
    ...result,
    effective_generative_ui_mode: mode.effective_mode,
    generative_ui_mode_source: mode.source,
  };
}

async function readConfig(options: ManagerAgentConfigRoutesOptions = {}): Promise<Record<string, unknown>> {
  try {
    const config = await ensurePreferredManagerAgentConfig(options);
    return voiceCompatConfig(config as unknown as Record<string, unknown>);
  } catch {
    return voiceCompatConfig(DEFAULT_VOICE_AGENT_CONFIG);
  }
}

async function saveConfig(
  patch: Record<string, unknown>,
  options: ManagerAgentConfigRoutesOptions,
): Promise<Record<string, unknown>> {
  const saved = await validateAndSaveManagerAgentConfig(patch, options) as unknown as Record<string, unknown>;
  return voiceCompatConfig(saved);
}

function widgetFileRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): boolean {
  if (!pathname.startsWith("/api/voice-agent/widget-files")) return false;

  if (method === "GET" && pathname === "/api/voice-agent/widget-files/types") {
    ok(res, "Widget file types loaded", { types: listWidgetFileTypes() });
    return true;
  }

  if (method === "POST" && pathname === "/api/voice-agent/widget-files/validate") {
    readJsonBody(req)
      .then((body) => {
        const result = validateWidgetToml(
          String(body.toml || ""),
          String(body.widget_type || "") as WidgetFileType,
        );
        ok(res, "Widget file validated", result);
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  if (method === "POST" && pathname === "/api/voice-agent/widget-files/write") {
    readJsonBody(req)
      .then((body) => {
        const result = writeWidgetFile({
          projectId: body.project_id,
          sessionId: body.session_id,
          widgetId: body.widget_id,
          widgetType: String(body.widget_type || "") as WidgetFileType,
          tomlContent: String(body.toml || ""),
        });
        ok(res, "Widget file written", result);
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  if (method === "POST" && pathname === "/api/voice-agent/widget-files/voice-memo") {
    readJsonBody(req)
      .then((body) => {
        const result = writeVoiceMemoWidget({
          projectId: typeof body.project_id === "string" ? body.project_id : null,
          sessionId: typeof body.session_id === "string" ? body.session_id : null,
          input: body && typeof body.memo === "object" && !Array.isArray(body.memo)
            ? body.memo as Record<string, unknown>
            : body as Record<string, unknown>,
        });
        if (!result.write_result.ok) {
          ok(res, "Voice memo widget rejected", {
            ok: false,
            errors: result.write_result.errors,
            file: result.write_result.file,
          });
          return;
        }
        ok(res, "Voice memo widget written", {
          ok: true,
          memo_path: result.memo_path,
          widget_id: result.widget_id,
          status: result.status,
          widget: result.widget,
          file: result.write_result.file,
        });
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  if (method === "POST" && pathname === "/api/voice-agent/widget-files/read") {
    readJsonBody(req)
      .then((body) => {
        const widgetType = typeof body.widget_type === "string" && body.widget_type.trim()
          ? body.widget_type as WidgetFileType
          : undefined;
        const result = readWidgetFile({
          projectId: body.project_id,
          sessionId: body.session_id,
          widgetId: body.widget_id,
          widgetType,
        });
        ok(res, "Widget file read", result);
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  if (method === "POST" && pathname === "/api/voice-agent/widget-files/remove") {
    readJsonBody(req)
      .then((body) => {
        const result = removeWidgetFile({
          projectId: body.project_id,
          sessionId: body.session_id,
          widgetId: body.widget_id,
        });
        ok(res, "Widget file removed", result);
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  if (method === "POST" && pathname === "/api/voice-agent/widget-files/example") {
    readJsonBody(req)
      .then((body) => ok(res, "Widget TOML example loaded", {
        widget_type: body.widget_type,
        toml: widgetTomlExample(String(body.widget_type || "") as WidgetFileType),
      }))
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  badRequest(res, "Unsupported widget file route");
  return true;
}

// ── Current-session pointer ───────────────────────────────────────────────
// Single-user system: the server is the single source of truth for "which
// session is the user currently viewing". Stored as a dedicated row
// (id="current_session") in voice_agent_config, isolated from the legacy
// default config document. Manager Agent runtime config lives only in
// manager_agent_config.
const CURRENT_SESSION_ROW_ID = "current_session";

function getCurrentSessionId(): string | null {
  try {
    const row = getDb()
      .prepare("SELECT data FROM voice_agent_config WHERE id = ?")
      .get(CURRENT_SESSION_ROW_ID) as { data: string } | undefined;
    if (!row) return null;
    const parsed = parseJsonRow<{ session_id?: string }>(row.data);
    return typeof parsed.session_id === "string" && parsed.session_id ? parsed.session_id : null;
  } catch {
    return null;
  }
}

function setCurrentSessionId(sessionId: string | null): void {
  const data = encodeJson({ session_id: sessionId });
  getDb()
    .prepare(`
      INSERT INTO voice_agent_config(id, updated_at, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data
    `)
    .run(CURRENT_SESSION_ROW_ID, now(), data);
}

function projectWorkspacePath(projectId?: string | null): string | null {
  if (!projectId) return null;
  const project = getProject(projectId);
  const raw = project?.workspace_path ?? project?.project_root;
  if (!raw) return null;
  const resolved = path.resolve(raw.replace(/^~/, process.env.HOME || ""));
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : null;
}

function newWorkspace(projectId?: string | null): VoiceWorkspace {
  const timestamp = now();
  const sessionId = generateId("voice-");
  const assetsDir = voiceAssetsDir(projectId);
  const generativeUiMode = resolveConfiguredGenerativeUiMode(
    readManagerAgentConfig().generative_ui_mode,
  );
  return {
    session_id: sessionId,
    mode: "voice",
    generative_ui_mode: generativeUiMode,
    project_id: projectId ?? null,
    project_workspace_path: projectWorkspacePath(projectId),
    voice_assets_dir: assetsDir,
    voice_ui_rules: createVoiceUiRulesSnapshot(sessionId, projectId),
    manager_session_id: null,
    manager_run_id: null,
    manager_run_ids: [],
    orchestrator_session_id: null,
    source_issue_number: null,
    source_issue_url: null,
    source_issue_title: null,
    session_title: null,
    session_slate: "",
    active_objective: null,
    task_draft: null,
    pending_confirmations: [],
    memory_refs: [],
    conversation: [],
    debug_events: [],
    progress_brief: { status: "idle", short_text: "", updated_at: timestamp },
    widgets: [],
    plugin_nodes: [],
    ui_events: [],
    codex_monitor_status: "idle",
    codex_monitor_run_id: null,
    ended_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function workspaceRunIds(workspace: VoiceWorkspace): string[] {
  const values = [
    ...(Array.isArray(workspace.manager_run_ids) ? workspace.manager_run_ids : []),
    ...(workspace.manager_run_id ? [workspace.manager_run_id] : []),
  ].map((item) => String(item || "").trim()).filter(Boolean);
  return Array.from(new Set(values));
}

function syncWorkspaceRunIds(workspace: VoiceWorkspace, runIds: string[]): void {
  const unique = Array.from(new Set(runIds.map((item) => item.trim()).filter(Boolean)));
  workspace.manager_run_ids = unique;
  workspace.manager_run_id = unique.length ? unique[unique.length - 1] : null;
}

function syncVoiceWorkspaceTables(workspace: VoiceWorkspace): void {
  const db = getDb();
  const sessionStatus = workspace.progress_brief.status === "error" ? "failed" : workspace.progress_brief.status;
  const runIds = workspaceRunIds(workspace);
  db.prepare(`
    INSERT INTO sessions(
      id, session_id, session_type, project_id, status, prompt, start_time,
      end_time, message_count, run_ids, created_at, updated_at, data
    )
    VALUES (?, ?, 'voice_agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project_id = excluded.project_id,
      status = excluded.status,
      prompt = excluded.prompt,
      end_time = excluded.end_time,
      message_count = excluded.message_count,
      run_ids = excluded.run_ids,
      updated_at = excluded.updated_at,
      data = excluded.data
  `).run(
    workspace.session_id,
    workspace.session_id,
    workspace.project_id ?? null,
    normalizeStatus("session", sessionStatus, "idle"),
    workspace.session_title || workspace.session_slate || workspace.active_objective || null,
    workspace.created_at,
    workspace.ended_at ?? null,
    workspace.conversation.length,
    encodeJson(runIds),
    workspace.created_at,
    workspace.updated_at,
    encodeJson(workspace),
  );

  db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(workspace.session_id);
  const messageStmt = db.prepare(`
    INSERT INTO session_messages(id, session_id, sequence, message_type, content, metadata, timestamp, synced, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  workspace.conversation.forEach((message, index) => {
    messageStmt.run(
      `${workspace.session_id}:${message.id}`,
      workspace.session_id,
      index + 1,
      message.role,
      message.text,
      encodeJson({ channel: message.channel ?? "final" }),
      message.created_at,
      encodeJson(message),
    );
  });

  db.prepare("DELETE FROM voice_ui_events WHERE session_id = ?").run(workspace.session_id);
  const eventStmt = db.prepare(`
    INSERT INTO voice_ui_events(
      id, session_id, voice_message_id, sequence, event_type, widget_id,
      widget_type, payload, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  workspace.ui_events.forEach((event, index) => {
    const eventId = typeof event.id === "string" ? event.id : `${workspace.session_id}:evt:${index}`;
    eventStmt.run(
      eventId,
      workspace.session_id,
      typeof event.voice_message_id === "string" ? event.voice_message_id : null,
      typeof event.sequence === "number" ? event.sequence : index,
      typeof event.event_type === "string" ? event.event_type : "voice_event",
      typeof event.widget_id === "string" ? event.widget_id : null,
      typeof event.widget_type === "string" ? event.widget_type : null,
      encodeJson(event.payload ?? event),
      typeof event.created_at === "string" ? event.created_at : workspace.updated_at,
    );
  });
}

function persistWorkspace(workspace: VoiceWorkspace): void {
  const db = getDb();
  db.transaction(() => {
    // Canonical voice workspace body storage: the voice UI reads this JSON blob.
    // syncVoiceWorkspaceTables below maintains query/index projections.
    db.prepare(`
        INSERT INTO voice_agent_sessions(session_id, project_id, updated_at, data)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          project_id = excluded.project_id,
          updated_at = excluded.updated_at,
          data = excluded.data
      `)
      .run(workspace.session_id, workspace.project_id ?? null, workspace.updated_at, encodeJson(workspace));
    syncVoiceWorkspaceTables(workspace);
  })();
}

function saveWorkspace(workspace: VoiceWorkspace): VoiceWorkspace {
  workspace.updated_at = now();
  sanitizeLegacyProgrammaticWidgets(workspace);

  // The legacy workspace is always retained, including in prefer mode where
  // it is the fallback whenever no canonical projection exists.
  persistWorkspace(workspace);
  const previousDebugId = workspace.debug_events.at(-1)?.id;
  const hadCanonicalPending = Boolean(workspace.generative_ui_canonical_pending);
  reconcileGenerativeUiShadow(workspace);
  reconcileGenerativeUiCanonical(workspace);
  if (
    workspace.debug_events.at(-1)?.id !== previousDebugId
    || (hadCanonicalPending && !workspace.generative_ui_canonical_pending)
  ) {
    try {
      // Persist diagnostics and clear a canonical patch only after the
      // canonical transaction succeeds. A crash before this write safely
      // replays the same semantic patch on the next save.
      persistWorkspace(workspace);
    } catch {
      // Keep the diagnostic in the current response; a later save may persist it.
    }
  }
  return workspace;
}

function loadWorkspace(sessionId: string): VoiceWorkspace | undefined {
  try {
    const row = getDb()
      .prepare("SELECT data FROM voice_agent_sessions WHERE session_id = ?")
      .get(safeId(sessionId)) as { data: string } | undefined;
    return row ? sanitizeLegacyProgrammaticWidgets(parseJsonRow<VoiceWorkspace>(row.data)) : undefined;
  } catch {
    return undefined;
  }
}

function listWorkspaces(projectId?: string | null, limit = 30): VoiceWorkspace[] {
  const rows = projectId
    ? getDb()
        .prepare("SELECT data FROM voice_agent_sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?")
        .all(projectId, Math.max(1, Math.min(limit, 200))) as Array<{ data: string }>
    : getDb()
        .prepare("SELECT data FROM voice_agent_sessions ORDER BY updated_at DESC LIMIT ?")
        .all(Math.max(1, Math.min(limit, 200))) as Array<{ data: string }>;
  return rows
    .map((row) => {
      try {
        return sanitizeLegacyProgrammaticWidgets(parseJsonRow<VoiceWorkspace>(row.data));
      } catch {
        return undefined;
      }
    })
    .filter((item): item is VoiceWorkspace => Boolean(item))
    .filter((item) => !projectId || item.project_id === projectId)
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

function sanitizeLegacyProgrammaticWidgets(workspace: VoiceWorkspace): VoiceWorkspace {
  workspace.widgets = (workspace.widgets ?? []).filter((widget) => !LEGACY_PROGRAMMATIC_WIDGET_IDS.has(widget.id));
  return workspace;
}

function sessionItem(workspace: VoiceWorkspace): Record<string, unknown> {
  const runIds = workspaceRunIds(workspace);
  return {
    session_id: workspace.session_id,
    project_id: workspace.project_id ?? null,
    status: workspace.progress_brief.status || "idle",
    title: workspace.session_title || null,
    prompt: workspace.session_slate || workspace.active_objective || null,
    start_time: workspace.created_at,
    end_time: workspace.ended_at ?? null,
    message_count: workspace.conversation.length,
    run_ids: runIds,
    duration_seconds: null,
  };
}

function appendConversation(
  workspace: VoiceWorkspace,
  role: "user" | "assistant" | "system",
  text: string,
  channel: "final" | "commentary" = "final",
  kind: "message" | "error" = "message",
  spokenText?: string,
) {
  workspace.conversation.push({
    id: generateId("msg-"),
    role,
    text,
    ...(spokenText !== undefined ? { spoken_text: spokenText } : {}),
    channel,
    kind,
    created_at: now(),
  });
  workspace.conversation = workspace.conversation.slice(-80);
}

function upsertWidget(workspace: VoiceWorkspace, widget: VoiceWidget): void {
  workspace.widgets = [widget, ...workspace.widgets.filter((item) => item.id !== widget.id)].slice(0, 12);
  workspace.ui_events.push({
    id: generateId("evt-"),
    session_id: workspace.session_id,
    sequence: workspace.ui_events.length,
    event_type: "upsert_widget",
    widget_id: widget.id,
    widget_type: widget.type,
    payload: { widget },
    created_at: now(),
  });
  workspace.ui_events = workspace.ui_events.slice(-200);
}

function removeWidget(workspace: VoiceWorkspace, widgetId: string): void {
  const next = workspace.widgets.filter((item) => item.id !== widgetId);
  if (next.length === workspace.widgets.length) return;
  workspace.widgets = next;
  workspace.ui_events.push({
    id: generateId("evt-"),
    session_id: workspace.session_id,
    sequence: workspace.ui_events.length,
    event_type: "remove_widget",
    widget_id: widgetId,
    widget_type: "unknown",
    payload: {},
    created_at: now(),
  });
  workspace.ui_events = workspace.ui_events.slice(-200);
}

function voiceEvents(text: string, commentary: string[] = []) {
  const events = commentary.filter(Boolean).map((item) => ({ id: generateId("speech-"), channel: "commentary", text: item }));
  if (text.trim()) events.push({ id: generateId("speech-"), channel: "final", text });
  return events;
}

function shortText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxLength - 1))}…`;
}

function voiceSessionTitleFromUserText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const firstSentence = clean.split(/[。！？!?；;\r\n]/)[0]?.trim() || clean;
  return shortText(firstSentence.replace(/[。！？!?；;，,、\s]+$/g, ""), 80);
}

function ensureVoiceSessionTitle(workspace: VoiceWorkspace, text: string): void {
  if (workspace.session_title?.trim()) return;
  const title = voiceSessionTitleFromUserText(text);
  if (title) workspace.session_title = title;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cleanSpokenText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeProgressStatus(value: unknown, fallback: string): string {
  const status = typeof value === "string" ? value.trim() : "";
  if ([
    "idle",
    "clarifying",
    "needs_confirmation",
    "waiting_for_confirmation",
    "submitted",
    "running",
    "blocked",
    "done",
    "failed",
  ].includes(status)) {
    return status;
  }
  if (status === "error") return "failed";
  return fallback;
}

function normalizeWidget(raw: unknown): VoiceWidget | null {
  const item = objectValue(raw);
  if (!item) return null;
  const title = String(item.title || "").trim();
  if (!title) return null;
  const priority = item.priority === "low" || item.priority === "high" ? item.priority : "normal";
  const activeStep = typeof item.active_step === "number" && Number.isFinite(item.active_step)
    ? Math.max(0, Math.floor(item.active_step))
    : null;
  const type = String(item.type || "note").trim() || "note";
  const explicitId = String(item.id || "").trim();
  // 无显式 id 时基于 type+title 生成稳定 id，让同类型同标题的 widget 能被后续覆盖而非重复堆积
  const id = explicitId || `widget-${type}-${title.slice(0, 24)}`;
  const widget: VoiceWidget = {
    id,
    type,
    title: shortText(title, 80),
    body: typeof item.body === "string" ? item.body.trim() : "",
    priority,
    status: typeof item.status === "string" && item.status.trim() ? shortText(item.status, 40) : null,
    items: stringList(item.items),
    steps: stringList(item.steps),
    active_step: activeStep,
    data: objectValue(item.data) ?? {},
  };
  return widget;
}

function applyTaskDraftPatch(workspace: VoiceWorkspace, raw: unknown, fallbackText: string): boolean {
  const patch = objectValue(raw);
  if (!patch) return false;
  const request = String(patch.request || patch.summary || fallbackText).trim();
  const title = String(patch.title || request || fallbackText).trim();
  if (!request && !title) return false;
  const rawStatus = typeof patch.status === "string" ? patch.status.trim() : "";
  const status = rawStatus === "draft" || rawStatus === "needs_confirmation" || rawStatus === "submitted"
    ? rawStatus
    : "clarifying";
  workspace.session_slate = request || fallbackText;
  workspace.task_draft = {
    title: shortText(title || request || fallbackText || "语音任务", 24),
    request: request || fallbackText,
    acceptance: stringList(patch.acceptance),
    constraints: stringList(patch.constraints),
    status,
  };
  workspace.active_objective = request || fallbackText;
  if (status === "needs_confirmation") {
    workspace.pending_confirmations = [{ id: "submit-task", kind: "submit_task", summary: workspace.task_draft.title }];
    workspace.progress_brief = { status: "waiting_for_confirmation", short_text: "等待确认", updated_at: now() };
  } else {
    workspace.pending_confirmations = [];
    workspace.progress_brief = { status: status === "draft" ? "clarifying" : status, short_text: "已整理任务草稿", updated_at: now() };
  }
  upsertWidget(workspace, {
    id: "task-draft",
    type: "task_draft",
    title: workspace.task_draft.title,
    body: workspace.task_draft.request,
    priority: "normal",
    status: workspace.task_draft.status,
    items: workspace.task_draft.acceptance,
    steps: workspace.task_draft.constraints,
    active_step: 0,
    data: { task_draft: workspace.task_draft },
  });
  return true;
}

function queueCanonicalNodeUpsert(workspace: VoiceWorkspace, node: GenerativeUiNodeV1): void {
  if (!effectiveGenerativeUiPreferEnabled(workspace)) return;
  const scope = { type: "voice_session", id: workspace.session_id } as const;
  const baseRevision = persistentGenerativeUiDocumentService
    .findActiveForScope(scope, "canonical")?.revision ?? 0;
  if (workspace.generative_ui_canonical_pending?.base_revision !== baseRevision) {
    workspace.generative_ui_canonical_pending = {
      base_revision: baseRevision,
      upsert: [],
      remove_ids: [],
    };
  }
  const pending = workspace.generative_ui_canonical_pending;
  const existing = pending.upsert.findIndex((candidate) => candidate.id === node.id);
  if (existing >= 0) pending.upsert[existing] = structuredClone(node);
  else pending.upsert.push(structuredClone(node));
  pending.remove_ids = pending.remove_ids.filter((nodeId) => nodeId !== node.id);
}

function queueCanonicalNodeRemoval(workspace: VoiceWorkspace, nodeId: string): void {
  if (!effectiveGenerativeUiPreferEnabled(workspace)) return;
  const scope = { type: "voice_session", id: workspace.session_id } as const;
  const baseRevision = persistentGenerativeUiDocumentService
    .findActiveForScope(scope, "canonical")?.revision ?? 0;
  if (workspace.generative_ui_canonical_pending?.base_revision !== baseRevision) {
    workspace.generative_ui_canonical_pending = {
      base_revision: baseRevision,
      upsert: [],
      remove_ids: [],
    };
  }
  const pending = workspace.generative_ui_canonical_pending;
  pending.upsert = pending.upsert.filter((node) => node.id !== nodeId);
  if (!pending.remove_ids.includes(nodeId)) pending.remove_ids.push(nodeId);
}

function applyVoiceSurfaceFromResult(
  workspace: VoiceWorkspace,
  result: Record<string, unknown>,
  fallbackText: string,
  pluginContext: HomerailPluginTurnContextV1,
): boolean {
  const surface = objectValue(result.voice_surface);
  let changed = false;
  const taskDraft = objectValue(surface?.task_draft) ?? objectValue(result.task_draft) ?? objectValue(result.task_draft_patch);
  if (taskDraft && applyTaskDraftPatch(workspace, taskDraft, fallbackText)) changed = true;

  const progress = objectValue(surface?.progress) ?? objectValue(result.progress);
  if (progress) {
    workspace.progress_brief = {
      status: normalizeProgressStatus(progress.status, workspace.progress_brief.status || "done"),
      short_text: shortText(String(progress.short_text || workspace.progress_brief.short_text || fallbackText || "状态已更新"), 80),
      updated_at: now(),
    };
    changed = true;
  }

  const rawPluginProjections = Array.isArray(surface?.plugin_projections) ? surface.plugin_projections : [];
  const acceptedPluginProjections: Array<{ node: GenerativeUiNodeV1; legacyWidget: VoiceWidget | null }> = [];
  const pluginProjectionCommitEnabled = effectiveGenerativeUiMode(workspace) !== "off";
  if (rawPluginProjections.length && !pluginProjectionCommitEnabled) {
    appendDebugEvent(
      workspace,
      "plugin_projection_mode_rejected",
      "Plugin projections cannot commit while Generative UI mode is off",
      "warning",
    );
  }
  for (const rawEnvelope of pluginProjectionCommitEnabled ? rawPluginProjections : []) {
    try {
      const { envelope, node } = acceptPluginToolExecution(rawEnvelope, pluginContext);
      const legacyWidget = envelope.projection.legacy_widget
        ? normalizeWidget(envelope.projection.legacy_widget)
        : null;
      if (envelope.projection.legacy_widget && !legacyWidget) {
        throw new Error(`Plugin legacy bridge is invalid after execution acceptance: ${node.id}`);
      }
      acceptedPluginProjections.push({ node, legacyWidget });
    } catch (cause) {
      appendDebugEvent(
        workspace,
        "plugin_projection_rejected",
        cause instanceof Error ? cause.message : String(cause),
        "warning",
      );
    }
  }

  const safePluginProjections: typeof acceptedPluginProjections = [];
  const batchIdentities = new Map<string, string>();
  for (const accepted of acceptedPluginProjections) {
    // Node identity follows the canonical Document reducer: an id may be
    // updated by a newer package from the same plugin as long as its semantic
    // Kind is unchanged. Package version is provenance, not node ownership.
    const identityKey = `${accepted.node.owner.id}\u0000${accepted.node.kind}`;
    const batchIdentity = batchIdentities.get(accepted.node.id);
    const existingPluginNode = (workspace.plugin_nodes ?? []).find((node) => node.id === accepted.node.id);
    const existingWidget = workspace.widgets.find((widget) => widget.id === accepted.node.id);
    const ownershipConflict = (
      (batchIdentity !== undefined && batchIdentity !== identityKey)
      || (
        existingPluginNode !== undefined
        && (
          existingPluginNode.owner.id !== accepted.node.owner.id
          || existingPluginNode.kind !== accepted.node.kind
        )
      )
      || (existingWidget !== undefined && existingPluginNode === undefined)
    );
    if (ownershipConflict) {
      appendDebugEvent(
        workspace,
        "plugin_projection_ownership_rejected",
        `Plugin projection cannot take over an existing UI id: ${accepted.node.id}`,
        "warning",
      );
      continue;
    }
    batchIdentities.set(accepted.node.id, identityKey);
    safePluginProjections.push(accepted);
  }
  const claimedPluginNodeIds = new Set(safePluginProjections.map((accepted) => accepted.node.id));

  // 优先用 voice_surface.widgets；只有 surface 缺失时才回退到顶层 result.widgets，
  // 避免两边同一数据被各生成一个 id 导致重复卡片。插件兼容 Widget
  // 只能在 broker 验收后从 execution envelope 物化，不能走通用 Widget 通道。
  const rawWidgets = Array.isArray(surface?.widgets) && surface.widgets.length
    ? surface.widgets
    : (Array.isArray(result.widgets) ? result.widgets : []);
  let pluginPolicyCatalog: { legacy_widget_reservations: ReturnType<typeof assembleLegacyWidgetReservations> } | undefined;
  let pluginPolicyUnavailable = false;
  if (rawWidgets.length && effectiveGenerativeUiMode(workspace) !== "off") {
    try {
      pluginPolicyCatalog = { legacy_widget_reservations: assembleLegacyWidgetReservations() };
    } catch (cause) {
      pluginPolicyUnavailable = true;
      appendDebugEvent(
        workspace,
        "plugin_widget_policy_unavailable",
        cause instanceof Error ? cause.message : String(cause),
        "warning",
      );
    }
  }
  for (const rawWidget of rawWidgets) {
    const widget = normalizeWidget(rawWidget);
    if (widget) {
      if (claimedPluginNodeIds.has(widget.id)) continue;
      if (pluginPolicyUnavailable) continue;
      const pluginOwnedType = managerAgentPluginOwnedLegacyWidgetType(pluginPolicyCatalog, widget);
      if (pluginOwnedType) {
        appendDebugEvent(
          workspace,
          "plugin_widget_bypass_rejected",
          `Plugin-owned Widget type requires an accepted plugin execution: ${pluginOwnedType}`,
          "warning",
        );
        continue;
      }
      if ((workspace.plugin_nodes ?? []).some((node) => node.id === widget.id)) {
        appendDebugEvent(
          workspace,
          "plugin_widget_conflict_rejected",
          `Legacy Widget cannot replace a semantic plugin node without an accepted plugin execution: ${widget.id}`,
          "warning",
        );
        continue;
      }
      upsertWidget(workspace, widget);
      changed = true;
    }
  }

  for (const accepted of safePluginProjections) {
    if (accepted.legacyWidget) upsertWidget(workspace, accepted.legacyWidget);
    const nodes = workspace.plugin_nodes ??= [];
    const existing = nodes.findIndex((candidate) => candidate.id === accepted.node.id);
    if (existing >= 0) nodes[existing] = accepted.node;
    else nodes.push(accepted.node);
    queueCanonicalNodeUpsert(workspace, accepted.node);
    changed = true;
  }

  const removeIds = [
    ...(Array.isArray(surface?.remove_widget_ids) ? surface.remove_widget_ids : []),
    ...(Array.isArray(result.remove_widget_ids) ? result.remove_widget_ids : []),
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const canonicalDocument = effectiveGenerativeUiPreferEnabled(workspace)
    ? persistentGenerativeUiDocumentService.findActiveForScope(
      { type: "voice_session", id: workspace.session_id },
      "canonical",
    )
    : undefined;
  for (const id of removeIds) {
    removeWidget(workspace, id);
    const removedPluginNode = Boolean(
      workspace.plugin_nodes?.some((node) => node.id === id)
      || canonicalDocument?.nodes.some((node) => (
        node.id === id && node.kind === "com.homerail.core/generated_view"
      )),
    );
    if (workspace.plugin_nodes) {
      workspace.plugin_nodes = workspace.plugin_nodes.filter((node) => node.id !== id);
    }
    if (removedPluginNode) queueCanonicalNodeRemoval(workspace, id);
    changed = true;
  }
  return changed;
}

function voiceSpokenText(raw: string, runIds: string[], status: string): string {
  const clean = cleanSpokenText(raw);
  if (runIds.length) return "已启动执行，我会继续跟进。";
  if (status === "blocked" || status === "failed") return "处理被阻塞，原因已放到屏幕上。";
  return shortText(clean || "已处理。", 80);
}

function appendDebugEvent(
  workspace: VoiceWorkspace,
  code: string,
  message: string,
  level: "debug" | "info" | "warning" | "error" = "info",
): void {
  workspace.debug_events.push({
    id: generateId("debug-"),
    code,
    message: shortText(message, 500),
    level,
    created_at: now(),
  });
  workspace.debug_events = workspace.debug_events.slice(-80);
}

function appendShadowDebugEvent(
  workspace: VoiceWorkspace,
  code: string,
  message: string,
  level: "debug" | "warning",
): void {
  const duplicate = workspace.debug_events
    .slice(-10)
    .some((event) => event.code === code && event.message === shortText(message, 500));
  if (!duplicate) appendDebugEvent(workspace, code, message, level);
}

function recordShadowSnapshot(workspace: VoiceWorkspace, snapshot: GenerativeUiShadowSnapshotV1): void {
  if (snapshot.status === "error") {
    appendShadowDebugEvent(
      workspace,
      "generative_ui_shadow_error",
      `status=error revision=${snapshot.document_revision} widgets=${snapshot.legacy_widget_count} code=${snapshot.error_code} fingerprint=${snapshot.error_hash}`,
      "warning",
    );
    return;
  }
  const differences = snapshot.expected_report.summary.difference_count +
    snapshot.repeat_report.summary.difference_count;
  const summary = [
    `matched=${snapshot.matched}`,
    `revision=${snapshot.document_revision}`,
    `widgets=${snapshot.legacy_widget_count}`,
    `differences=${differences}`,
  ].join(" ");
  appendShadowDebugEvent(
    workspace,
    snapshot.matched ? "generative_ui_shadow_matched" : "generative_ui_shadow_mismatch",
    summary,
    snapshot.matched ? "debug" : "warning",
  );
}

function reactivateGenerativeUiShadowIfReleased(workspace: VoiceWorkspace): void {
  // DELETE closes and releases the current shadow incarnation, but the legacy
  // API historically permits later Agent work on the same Voice session.
  // Every Agent entrypoint treats that work as an explicit new incarnation.
  if (workspace.generative_ui_mode === "shadow" && workspace.generative_ui_shadow_released) {
    delete workspace.generative_ui_shadow_released;
  }
}

function effectiveGenerativeUiMode(workspace: VoiceWorkspace): GenerativeUiMode {
  try {
    const globalMode = resolveConfiguredGenerativeUiModeDetails(
      readManagerAgentConfig().generative_ui_mode,
    ).effective_mode;
    return resolveSessionGenerativeUiMode(workspace.generative_ui_mode, globalMode);
  } catch {
    // A broken or emergency-off global setting must preserve the legacy path.
    return "off";
  }
}

function effectiveGenerativeUiShadowEnabled(workspace: VoiceWorkspace): boolean {
  if (workspace.generative_ui_mode !== "shadow" || workspace.generative_ui_shadow_released) return false;
  return effectiveGenerativeUiMode(workspace) === "shadow";
}

function effectiveGenerativeUiPreferEnabled(workspace: VoiceWorkspace): boolean {
  return workspace.generative_ui_mode === "prefer"
    && effectiveGenerativeUiMode(workspace) === "prefer";
}

function reconcileGenerativeUiShadow(workspace: VoiceWorkspace): void {
  // Existing and explicitly-off sessions take the exact legacy path without
  // reading config or touching the in-memory Document Service.
  if (!effectiveGenerativeUiShadowEnabled(workspace)) return;
  try {
    const snapshot = generativeUiShadowService.reconcile({
      sessionId: workspace.session_id,
      widgets: workspace.widgets,
      nodes: workspace.plugin_nodes ?? [],
      checkedAt: workspace.updated_at,
    });
    if (snapshot) recordShadowSnapshot(workspace, snapshot);
  } catch (cause) {
    const snapshot = generativeUiShadowService.recordFailure({
      sessionId: workspace.session_id,
      widgets: workspace.widgets,
      nodes: workspace.plugin_nodes ?? [],
      checkedAt: workspace.updated_at,
    }, cause);
    appendShadowDebugEvent(
      workspace,
      "generative_ui_shadow_error",
      `status=error revision=${snapshot.document_revision} widgets=${snapshot.legacy_widget_count} code=${snapshot.error_code} fingerprint=${snapshot.error_hash}`,
      "warning",
    );
  }
}

function reconcileGenerativeUiCanonical(workspace: VoiceWorkspace): void {
  const pending = workspace.generative_ui_canonical_pending;
  if (!pending || !effectiveGenerativeUiPreferEnabled(workspace)) return;
  try {
    applyVoiceCanonicalProjectionPatch({
      session_id: workspace.session_id,
      patch: pending,
      created_at: workspace.updated_at,
    });
    delete workspace.generative_ui_canonical_pending;
  } catch (cause) {
    if (cause instanceof VoiceCanonicalProjectionConflictError) {
      // The canonical head advanced after this Tool result was accepted (for
      // example, an Action committed first). Never replay stale Tool output on
      // the new head; a later Tool result must bind a fresh revision.
      delete workspace.generative_ui_canonical_pending;
    }
    appendDebugEvent(
      workspace,
      cause instanceof VoiceCanonicalProjectionConflictError
        ? "generative_ui_canonical_stale"
        : "generative_ui_canonical_error",
      cause instanceof Error ? cause.message : String(cause),
      "warning",
    );
  }
}

function activeGenerativeUiCursor(sessionId: string): number {
  const scope = { type: "voice_session", id: sessionId } as const;
  const document = persistentGenerativeUiDocumentService.findActiveForScope(scope, "legacy_widget_shadow");
  return document
    ? persistentGenerativeUiDocumentService.getCursor(document.document_id, scope)
    : 0;
}

function shouldStreamGenerativeUiShadow(workspace: VoiceWorkspace): boolean {
  return effectiveGenerativeUiShadowEnabled(workspace);
}

function streamCommittedGenerativeUiTransactions(
  res: http.ServerResponse,
  sessionId: string,
  afterSeq: number,
): number {
  const scope = { type: "voice_session", id: sessionId } as const;
  const document = persistentGenerativeUiDocumentService.findActiveForScope(scope, "legacy_widget_shadow");
  if (!document) return afterSeq;
  const committed = persistentGenerativeUiDocumentService.listTransactions(
    document.document_id,
    scope,
    afterSeq,
    100,
  );
  let cursor = afterSeq;
  for (const entry of committed) {
    streamLine(res, {
      type: "generative_ui",
      event: "transaction",
      stream_version: 1,
      authoritative: false,
      purpose: "legacy_widget_shadow",
      ...entry,
      revision: entry.committed_revision,
    });
    cursor = entry.seq;
  }
  return cursor;
}

function confirmedTaskMessage(workspace: VoiceWorkspace, fallbackText = ""): string {
  const draft = workspace.task_draft;
  if (!draft) return fallbackText || workspace.session_slate || workspace.active_objective || "用户已确认执行当前任务。";
  const sections = [
    "用户已确认执行以下任务。请使用主 Agent 工具执行真实操作；如果不能执行，返回真实阻塞原因，不要假装已经启动 DAG 或创建产物。",
    `标题：${draft.title}`,
    `请求：${draft.request}`,
  ];
  if (draft.acceptance.length) sections.push(`验收：${draft.acceptance.join("；")}`);
  if (draft.constraints.length) sections.push(`约束：${draft.constraints.join("；")}`);
  return sections.join("\n");
}

function voicePluginRoutingInputs(workspace: VoiceWorkspace, message: string): Record<string, unknown> {
  const title = workspace.task_draft?.title ?? workspace.session_title ?? shortText(message, 80);
  return {
    message,
    text: message,
    ...(title ? { title } : {}),
    ...(workspace.task_draft?.request ? { request: workspace.task_draft.request } : {}),
    ...(workspace.task_draft?.acceptance.length ? { acceptance: workspace.task_draft.acceptance } : {}),
    ...(workspace.task_draft?.constraints.length ? { constraints: workspace.task_draft.constraints } : {}),
    ...(workspace.session_slate ? { session_slate: workspace.session_slate } : {}),
    ...(workspace.active_objective ? { active_objective: workspace.active_objective } : {}),
  };
}

function managerAgentHistory(workspace: VoiceWorkspace): Array<{ role: string; content: string; timestamp?: string }> {
  return (workspace.conversation ?? []).slice(-24).map((item) => ({
    role: item.role,
    content: item.text,
    timestamp: item.created_at,
  }));
}

function markManagerAgentBlocker(workspace: VoiceWorkspace, code: string, message: string): ManagerAgentHandoffResult {
  appendDebugEvent(workspace, code, message, "error");
  const displayText = code === "manager_agent_unavailable"
    ? `主 Agent 执行入口不可用：${message}`
    : `主 Agent 执行失败：${message}`;
  workspace.progress_brief = { status: "error", short_text: shortText(displayText, 80), updated_at: now() };
  removeWidget(workspace, "manager-agent-blocker");
  removeWidget(workspace, "manager-run");
  appendConversation(workspace, "assistant", displayText, "final", "error");
  return { spoken_text: "", suggested_action: null, manager: { error: message, code }, manager_status: managerStatus(workspace) };
}

async function submitVoiceWorkspaceToManagerAgent(
  workspace: VoiceWorkspace,
  message: string,
  config: Record<string, unknown>,
  options?: ManagerAgentContainerOptions,
  realtimeHooks?: ManagerAgentRealtimeHooks,
  selectedNodeId?: string,
): Promise<ManagerAgentHandoffResult> {
  if (workspace.task_draft) workspace.task_draft.status = "submitted";
  workspace.pending_confirmations = [];
  workspace.progress_brief = { status: "submitted", short_text: "已确认，主 Agent 正在处理。", updated_at: now() };

  const requestedHarness = normalizeManagerAgentHarness(config.harness) ?? "claude_agent_sdk";
  if (!options && managerAgentRuntimePlacementForHarness(requestedHarness) === "container") {
    return markManagerAgentBlocker(workspace, "manager_agent_unavailable", "当前服务未启用容器执行入口");
  }

  let agentConfig;
  try {
    const settingId = typeof config.llm_setting_id === "string" ? config.llm_setting_id : undefined;
    const providerName = typeof config.provider_name === "string" ? config.provider_name : undefined;
    const modelName = typeof config.model_name === "string" ? config.model_name : undefined;
    const reasoningEffort = typeof config.reasoning_effort === "string" ? config.reasoning_effort : undefined;
    const serviceTier = typeof config.service_tier === "string" ? config.service_tier : null;
    agentConfig = resolveManagerAgentConfig(workspace.project_id ?? undefined, providerName, modelName, settingId, requestedHarness, reasoningEffort, serviceTier);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return markManagerAgentBlocker(workspace, "manager_config_error", detail);
  }

  let result: Record<string, unknown>;
  let pluginContext: HomerailPluginTurnContextV1;
  try {
    const voiceUiRules = ensureWorkspaceVoiceUiRules(workspace);
    const generativeUiMode = effectiveGenerativeUiMode(workspace);
    const canonicalDocument = generativeUiMode === "prefer"
      ? persistentGenerativeUiDocumentService.findActiveForScope(
        { type: "voice_session", id: workspace.session_id },
        "canonical",
      )
      : undefined;
    const canvasContext = generativeUiMode === "prefer"
      ? buildGenerativeUiCanvasContext(
        canonicalDocument,
        selectedNodeId,
      )
      : undefined;
    const pluginRoutingSource = assemblePluginTurnContext(undefined, {
      modality: "voice",
      include_agent_tools: generativeUiMode === "prefer" || generativeUiMode === "shadow",
      legacy_compatibility_mode: !(
        effectiveGenerativeUiShadowEnabled(workspace)
        || effectiveGenerativeUiPreferEnabled(workspace)
      ),
    });
    const turnInput: RunManagerAgentTurnInput = {
      message,
      project_id: workspace.project_id ?? undefined,
      session_id: workspace.manager_session_id ?? undefined,
      voice_session_id: workspace.session_id,
      continue_chat: true,
      response_mode: "voice",
      generative_ui_mode: generativeUiMode,
      canvas_context: canvasContext,
      history: managerAgentHistory(workspace),
      agent_config: agentConfig,
      voice_ui_rules: voiceUiRules,
      plugin_routing: {
        inputs: voicePluginRoutingInputs(workspace, message),
        source_context: pluginRoutingSource,
      },
    };
    if (realtimeHooks?.onSpeech) {
      let streamResult: Awaited<ReturnType<typeof runManagerAgentTurn>> | undefined;
      for await (const event of runManagerAgentTurnStream(turnInput, options)) {
        if (event.type === "commentary") {
          const text = String(event.text || "").trim();
          if (!text) continue;
          const spokenText = shortText(text, 120);
          appendConversation(workspace, "assistant", text, "commentary", "message", spokenText);
          realtimeHooks.streamedCommentaryTexts?.add(text);
          realtimeHooks.onSpeech({ id: generateId("speech-"), channel: "commentary", text: spokenText });
        } else if (event.type === "result") {
          streamResult = event.result;
        }
      }
      if (!streamResult) throw new Error("Manager Agent stream completed without a result");
      result = streamResult.result;
      pluginContext = streamResult.plugin_context;
    } else {
      const turn = await runManagerAgentTurn(turnInput, options);
      result = turn.result;
      pluginContext = turn.plugin_context;
    }
  } catch (err) {
    if (err instanceof ManagerAgentRuntimeError) {
      if (err.code === "manager_container_options_missing") {
        return markManagerAgentBlocker(workspace, "manager_agent_unavailable", "当前服务未启用容器执行入口");
      }
      if (err.code === "manager_container_error") {
        return markManagerAgentBlocker(workspace, "manager_container_error", err.message);
      }
      return markManagerAgentBlocker(workspace, "manager_chat_error", err.message);
    }
    const detail = err instanceof Error ? err.message : String(err);
    if (!options && managerAgentRuntimePlacement(agentConfig) === "container") {
      return markManagerAgentBlocker(workspace, "manager_agent_unavailable", "当前服务未启用容器执行入口");
    }
    return markManagerAgentBlocker(workspace, "manager_chat_error", detail);
  }

  const reply = typeof result.text === "string" && result.text.trim()
    ? result.text.trim()
    : "主 Agent 已处理。";
  const surface = objectValue(result.voice_surface);
  const surfaceCommentary = Array.isArray(surface?.commentary_texts) ? surface.commentary_texts : [];
  const alreadyStreamed = realtimeHooks?.streamedCommentaryTexts ?? new Set<string>();
  const commentaryMessages = [
    ...(Array.isArray(result.commentary_texts) ? result.commentary_texts : []),
    ...surfaceCommentary,
  ]
    .map((item) => String(item || "").trim())
    .filter((item) => item && !alreadyStreamed.has(item))
    .slice(0, 6)
    .map((text) => ({ text, spokenText: shortText(text, 120) }));
  const agentErrors = Array.isArray(result.agent_errors)
    ? result.agent_errors.map((item) => shortText(String(item || "").trim(), 500)).filter(Boolean).slice(0, 10)
    : [];
  for (const error of agentErrors) {
    appendDebugEvent(workspace, "manager_agent_warning", error, "warning");
  }
  const runId = typeof result.run_id === "string" && result.run_id.trim() ? result.run_id.trim() : undefined;
  const runIds = Array.isArray(result.run_ids)
    ? result.run_ids.map((item) => String(item || "").trim()).filter(Boolean)
    : runId
      ? [runId]
      : [];

  if (typeof result.session_id === "string" && result.session_id.trim()) workspace.manager_session_id = result.session_id.trim();
  if (runIds.length) {
    syncWorkspaceRunIds(workspace, runIds);
  }

  const objective = result.objective && typeof result.objective === "object" ? result.objective as Record<string, unknown> : null;
  const status = objective?.satisfied === false ? "blocked" : "done";
  const updatedAt = now();
  workspace.ended_at = updatedAt;
  workspace.progress_brief = {
    status,
    short_text: runIds.length ? "主 Agent 已启动执行" : shortText(reply, 80),
    updated_at: updatedAt,
  };
  applyVoiceSurfaceFromResult(workspace, result, reply, pluginContext!);
  const spoken = voiceSpokenText(
    typeof result.spoken_text === "string" && result.spoken_text.trim() ? result.spoken_text.trim() : reply,
    runIds,
    workspace.progress_brief.status || status,
  );
  // 生成式 UI 只能来自 Agent 显式返回的 voice_surface.widgets/show_* 工具结果；
  // Manager 执行状态只写 progress_brief/manager_run_id，不在这里程序化插入 status widget。
  removeWidget(workspace, "manager-run");
  removeWidget(workspace, "manager-agent-blocker");
  for (const commentary of commentaryMessages) {
    appendConversation(
      workspace,
      "assistant",
      commentary.text,
      "commentary",
      "message",
      commentary.spokenText,
    );
  }
  appendConversation(workspace, "assistant", reply, "final", "message", spoken);
  return {
    spoken_text: spoken,
    suggested_action: null,
    commentary_texts: commentaryMessages.map((item) => item.spokenText),
    manager: {
      text: reply,
      session_id: workspace.manager_session_id ?? null,
      run_id: workspace.manager_run_id ?? null,
      run_ids: runIds,
      runtime_placement: agentConfig.runtime_placement,
      objective,
      effective_config: objectValue(result.effective_config) ?? null,
      tool_calls: Array.isArray(result.tool_calls) ? result.tool_calls : [],
      tool_results: Array.isArray(result.tool_results) ? result.tool_results : [],
      agent_errors: agentErrors,
    },
    manager_status: managerStatus(workspace),
  };
}

async function processTurn(
  workspace: VoiceWorkspace,
  text: string,
  options?: ManagerAgentContainerOptions,
  realtimeHooks?: ManagerAgentRealtimeHooks,
  managerAgentConfigOptions: ManagerAgentConfigRoutesOptions = {},
  selectedNodeId?: string,
): Promise<VoiceTurnResult> {
  appendConversation(workspace, "user", text);
  ensureVoiceSessionTitle(workspace, text);
  const config = await readConfig(managerAgentConfigOptions);

  // 真实调用 Manager Agent：与文本模式 /api/manager/chat 走同一条链路。
  // voice agent 和 manager agent 是同一个主 Agent 的不同 I/O 表面。
  return submitVoiceWorkspaceToManagerAgent(
    workspace,
    text,
    config,
    options,
    realtimeHooks,
    selectedNodeId,
  );
}

function selectedGenerativeUiNodeId(body: Record<string, unknown>): string | undefined {
  if (body.selected_node_id === undefined || body.selected_node_id === null || body.selected_node_id === "") {
    return undefined;
  }
  if (typeof body.selected_node_id !== "string") {
    throw new HttpBadRequestError("selected_node_id must be a string");
  }
  const value = body.selected_node_id.trim();
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpBadRequestError("selected_node_id is invalid");
  }
  return value;
}

function managerStatus(workspace: VoiceWorkspace): Record<string, unknown> {
  // 优先用进程注册表的实时状态（turn 正在跑时 SQLite blob 还没更新）。
  const liveStatus = getTurnStatus(workspace.session_id);
  return {
    manager_session_id: workspace.manager_session_id ?? null,
    manager_run_id: workspace.manager_run_id ?? null,
    manager_status: liveStatus ?? workspace.progress_brief.status ?? "idle",
    run: workspace.manager_run_id ? { run_id: workspace.manager_run_id } : null,
    dag: null,
  };
}

function streamLine(res: http.ServerResponse, event: Record<string, unknown>): void {
  res.write(`${JSON.stringify(event)}\n`);
}

export function _clearStoredConfig(): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM voice_agent_config").run();
    db.prepare("DELETE FROM manager_agent_config").run();
    db.prepare("DELETE FROM voice_ui_events").run();
    db.prepare("DELETE FROM session_messages WHERE session_id IN (SELECT session_id FROM sessions WHERE session_type = 'voice_agent')").run();
    db.prepare("DELETE FROM sessions WHERE session_type = 'voice_agent'").run();
    db.prepare("DELETE FROM voice_agent_sessions").run();
  })();
  generativeUiShadowService.clear();
}

export function _getGenerativeUiShadowForTest(sessionId: string): Record<string, unknown> {
  return {
    snapshot: generativeUiShadowService.getSnapshot(sessionId) ?? null,
    document: generativeUiShadowService.getDocument(sessionId) ?? null,
  };
}

export function voiceAgentBootstrapHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  managerAgentOptions?: ManagerAgentContainerOptions,
  managerAgentConfigOptions: ManagerAgentConfigRoutesOptions = {},
): boolean {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (widgetFileRoutesHandler(req, res, pathname, method)) {
    return true;
  }

  if (method === "GET" && pathname === "/api/voice-agent/config") {
    void readConfig(managerAgentConfigOptions)
      .then((config) => ok(res, "Voice Agent config loaded", config))
      .catch((error) => serverError(res, error instanceof Error ? error.message : String(error)));
    return true;
  }

  if (method === "GET" && pathname === "/api/voice-agent/ui-rules") {
    try {
      const createTemplate = url.searchParams.get("create") === "1" || url.searchParams.get("create") === "true";
      ok(res, "Voice UI rules loaded", readVoiceUiRulesAsset(createTemplate));
    } catch (err) {
      serverError(res, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  if (method === "PUT" && pathname === "/api/voice-agent/ui-rules") {
    readJsonBody(req)
      .then((body) => {
        const content = body.reset_to_template === true
          ? USER_VOICE_UI_RULES_TEMPLATE
          : typeof body.content === "string"
            ? body.content
            : "";
        writeVoiceUiRulesAsset(content);
        ok(res, "Voice UI rules saved", readVoiceUiRulesAsset(false));
      })
      .catch((err) => serverError(res, err instanceof Error ? err.message : String(err)));
    return true;
  }

  // Codex 可用性检测：检查 CLI 是否安装 + 是否有登录态
  if (method === "GET" && pathname === "/api/voice-agent/codex-status") {
    const requested = process.env.HOMERAIL_CODEX_BIN || process.env.CODEX_BIN_PATH || "codex";
    const resolved = resolveCodexBinary(requested);
    let available = false;
    let version: string | undefined;
    if (resolved) {
      const result = runCodexCommandSync(resolved.command, ["--version"]);
      if (result.status === 0) {
        available = true;
        version = (result.stdout || "").trim().split("\n")[0] || undefined;
      }
    }
    // 检查登录态：~/.codex/auth.json 存在且非空
    let loggedIn = false;
    try {
      const authPath = path.join(os.homedir(), ".codex", "auth.json");
      if (fs.existsSync(authPath)) {
        const content = fs.readFileSync(authPath, "utf-8").trim();
        loggedIn = content.length > 0 && content !== "{}";
      }
    } catch {
      loggedIn = false;
    }
    ok(res, "Codex status checked", { available, logged_in: loggedIn, version, binary: resolved?.command ?? requested });
    return true;
  }

  if (method === "PUT" && pathname === "/api/voice-agent/config") {
    readJsonBody(req)
      .then(async (body) => {
        try {
          const next = await saveConfig(body, managerAgentConfigOptions);
          ok(res, "Voice Agent config saved", next);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof ManagerAgentConfigValidationError) badRequest(res, message);
          else serverError(res, message);
        }
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  if (method === "POST" && pathname === "/api/voice-agent/sessions") {
    readJsonBody(req)
      .then((body) => {
        const projectId = typeof body.project_id === "string" ? body.project_id : null;
        created(res, "Voice session created", saveWorkspace(newWorkspace(projectId)));
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  if (method === "GET" && pathname === "/api/voice-agent/sessions") {
    const projectId = url.searchParams.get("project_id");
    const limit = Number(url.searchParams.get("limit") || "30") || 30;
    ok(res, "ok", { sessions: listWorkspaces(projectId, limit).map(sessionItem) });
    return true;
  }

  if (method === "GET" && pathname === "/api/voice-agent/current-session") {
    ok(res, "ok", { session_id: getCurrentSessionId() });
    return true;
  }

  if (method === "PUT" && pathname === "/api/voice-agent/current-session") {
    readJsonBody(req)
      .then((body) => {
        const sessionId = typeof body.session_id === "string" ? body.session_id : null;
        setCurrentSessionId(sessionId);
        ok(res, "ok", { session_id: sessionId });
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  const artifactPreview = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/artifacts\/preview$/);
  const artifactPublish = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/artifacts\/publish$/);
  const artifactFile = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/artifacts\/(.+)$/);
  if (method === "POST" && artifactPublish) {
    readJsonBody(req).then((body) => {
      const sessionId = decodeURIComponent(artifactPublish[1]);
      const workspace = loadWorkspace(sessionId);
      if (!workspace) throw new HttpNotFoundError("Voice workspace not found");
      const sourcePath = typeof body.source_path === "string" ? body.source_path : "";
      if (!sourcePath) throw new HttpBadRequestError("Missing required field: source_path");
      const artifact = publishVoiceArtifact({
        session_id: sessionId,
        project_id: workspace.project_id,
        source_path: sourcePath,
        title: typeof body.title === "string" ? body.title : undefined,
      });
      ok(res, "Voice artifact published", { artifact });
    }).catch((cause) => {
      if (cause instanceof HttpNotFoundError) notFound(res, cause.message);
      else badRequest(res, cause instanceof Error ? cause.message : "Artifact publishing failed");
    });
    return true;
  }
  if (method === "GET" && (artifactPreview || artifactFile)) {
    try {
      const sessionId = decodeURIComponent((artifactPreview ?? artifactFile)![1]);
      const filePath = artifactPreview ? "index.html" : decodeURIComponent(artifactFile![2]);
      const resolved = resolveVoiceArtifact(sessionId, filePath);
      const ext = path.extname(resolved).toLowerCase();
      const type = ext === ".html" ? "text/html; charset=utf-8"
        : ext === ".png" ? "image/png"
          : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
            : ext === ".webp" ? "image/webp"
              : "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        ...(ext === ".html" ? { "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-pointer-lock allow-popups" } : {}),
      });
      fs.createReadStream(resolved).pipe(res);
    } catch (err) {
      notFound(res, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  const sessionMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "GET") {
    const workspace = loadWorkspace(decodeURIComponent(sessionMatch[1]));
    if (!workspace) notFound(res, "Voice workspace not found");
    else ok(res, "Voice session loaded", workspace);
    return true;
  }

  if (sessionMatch && method === "DELETE") {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const workspace = loadWorkspace(sessionId);
    if (!workspace) {
      notFound(res, "Voice workspace not found");
      return true;
    }
    workspace.progress_brief = { status: "done", short_text: "会话已关闭。", updated_at: now() };
    if (workspace.generative_ui_mode === "shadow") workspace.generative_ui_shadow_released = true;
    saveWorkspace(workspace);
    if (workspace.generative_ui_shadow_released) generativeUiShadowService.deleteSession(sessionId);
    ok(res, "Voice session closed", { session_id: sessionId });
    return true;
  }

  const managerStatusMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/manager-status$/);
  if (managerStatusMatch && method === "POST") {
    const workspace = loadWorkspace(decodeURIComponent(managerStatusMatch[1]));
    if (!workspace) notFound(res, "Voice workspace not found");
    else ok(res, "Manager status refreshed", { workspace: saveWorkspace(workspace), manager_status: managerStatus(workspace) });
    return true;
  }

  const stopMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/monitor\/stop$/);
  if (stopMatch && method === "POST") {
    const workspace = loadWorkspace(decodeURIComponent(stopMatch[1]));
    if (!workspace) {
      notFound(res, "Voice workspace not found");
      return true;
    }
    workspace.codex_monitor_status = "done";
    workspace.progress_brief = { status: "done", short_text: "监听已停止。", updated_at: now() };
    ok(res, "Voice monitor stopped", { workspace: saveWorkspace(workspace) });
    return true;
  }

  const turnMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/turn$/);
  if (turnMatch && method === "POST") {
    readJsonBody(req)
      .then(async (body) => {
        const sessionId = decodeURIComponent(turnMatch[1]);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) {
          badRequest(res, "Missing required field: text");
          return;
        }
        const projectIdPatch = typeof body.project_id === "string" ? body.project_id : null;
        const selectedNodeId = selectedGenerativeUiNodeId(body);
        // workspace 必须在锁内重新读取：否则并发 turn 的第二个请求会拿着旧快照覆盖第一个的结果。
        const result = await withSessionLock(sessionId, async () => {
          const workspace = loadWorkspace(sessionId);
          if (!workspace) throw new HttpNotFoundError("Voice workspace not found");
          reactivateGenerativeUiShadowIfReleased(workspace);
          if (projectIdPatch && !workspace.project_id) workspace.project_id = projectIdPatch;
          registerTurn(sessionId, "running");
          try {
            const r = await processTurn(
              workspace,
              text,
              managerAgentOptions,
              undefined,
              managerAgentConfigOptions,
              selectedNodeId,
            );
            const saved = saveWorkspace(workspace);
            completeTurn(sessionId, saved.progress_brief?.status || "done");
            return { result: r, saved };
          } catch (err) {
            completeTurn(sessionId, "error");
            throw err;
          }
        });
        const handoff = result.result as Partial<ManagerAgentHandoffResult>;
        ok(res, "Voice turn processed", {
          workspace: result.saved,
          spoken_text: result.result.spoken_text,
          voice_events: voiceEvents(result.result.spoken_text, result.result.commentary_texts),
          suggested_action: result.result.suggested_action,
          manager: handoff.manager,
          manager_status: handoff.manager_status,
        });
      })
      .catch((err) => {
        if (err instanceof HttpNotFoundError) notFound(res, err.message);
        else badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  const turnStreamMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/turn\/stream$/);
  if (turnStreamMatch && method === "POST") {
    readJsonBody(req)
      .then(async (body) => {
        const sessionId = decodeURIComponent(turnStreamMatch[1]);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const projectIdPatch = typeof body.project_id === "string" ? body.project_id : null;
        const selectedNodeId = selectedGenerativeUiNodeId(body);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        if (!text) {
          streamLine(res, { type: "error", message: "Missing required field: text" });
          res.end();
          return;
        }
        // workspace 必须在锁内重新读取，避免并发 turn 拿旧快照覆盖。
        // accepted 行在锁内发送，确保用户看到的 workspace 是锁内 fresh 版本。
        const result = await withSessionLock(sessionId, async () => {
          const workspace = loadWorkspace(sessionId);
          if (!workspace) {
            streamLine(res, { type: "error", message: "Voice workspace not found" });
            res.end();
            return null;
          }
          reactivateGenerativeUiShadowIfReleased(workspace);
          const streamGenerativeUi = shouldStreamGenerativeUiShadow(workspace);
          let generativeUiCursor = streamGenerativeUi ? activeGenerativeUiCursor(sessionId) : 0;
          if (projectIdPatch && !workspace.project_id) workspace.project_id = projectIdPatch;
          workspace.progress_brief = {
            status: "running",
            short_text: "正在交给主 Agent。",
            updated_at: now(),
          };
          streamLine(res, { type: "workspace", phase: "accepted", workspace });
          registerTurn(sessionId, "running");
          try {
            const streamedCommentaryTexts = new Set<string>();
            const r = await processTurn(workspace, text, managerAgentOptions, {
              streamedCommentaryTexts,
              onSpeech: (event) => {
                const saved = saveWorkspace(workspace);
                if (streamGenerativeUi) {
                  generativeUiCursor = streamCommittedGenerativeUiTransactions(
                    res,
                    sessionId,
                    generativeUiCursor,
                  );
                }
                streamLine(res, { type: "speech", event, workspace: saved });
              },
            }, managerAgentConfigOptions, selectedNodeId);
            const saved = saveWorkspace(workspace);
            if (streamGenerativeUi) {
              generativeUiCursor = streamCommittedGenerativeUiTransactions(
                res,
                sessionId,
                generativeUiCursor,
              );
            }
            completeTurn(sessionId, saved.progress_brief?.status || "done");
            return { result: r, saved };
          } catch (err) {
            completeTurn(sessionId, "error");
            throw err;
          }
        });
        if (!result) return; // workspace not found, already streamed error
        const handoff = result.result as Partial<ManagerAgentHandoffResult>;
        streamLine(res, { type: "workspace", workspace: result.saved });
        for (const event of voiceEvents(result.result.spoken_text, result.result.commentary_texts)) streamLine(res, { type: "speech", event, workspace: result.saved });
        streamLine(res, {
          type: "done",
          workspace: result.saved,
          spoken_text: result.result.spoken_text,
          voice_events: [],
          suggested_action: result.result.suggested_action,
          manager: handoff.manager,
          manager_status: handoff.manager_status,
        });
        res.end();
      })
      .catch((err) => {
        // 流式响应的头可能已发送（writeHead 在 try 之前），不能重复写
        if (!res.headersSent) {
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        }
        try {
          streamLine(res, { type: "error", message: err instanceof Error ? err.message : "Invalid JSON body" });
        } catch {
          // 头已发送但流已关闭时 streamLine 可能抛错，忽略
        }
        try { res.end(); } catch { /* already ended */ }
      });
    return true;
  }

  const confirmMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/confirm$/);
  if (confirmMatch && method === "POST") {
    readJsonBody(req)
      .then(async (body) => {
        const sessionId = decodeURIComponent(confirmMatch[1]);
        const requested = typeof body.confirmation_id === "string" ? body.confirmation_id : "";
        const config = await readConfig(managerAgentConfigOptions);
        // workspace 在锁内重新读取，确保 confirm 基于最新 workspace。
        const result = await withSessionLock(sessionId, async () => {
          const workspace = loadWorkspace(sessionId);
          if (!workspace) throw new HttpNotFoundError("Voice workspace not found");
          reactivateGenerativeUiShadowIfReleased(workspace);
          const expected = workspace.pending_confirmations[0]?.id;
          if (requested && expected && requested !== expected) {
            throw new HttpBadRequestError("Confirmation id mismatch");
          }
          registerTurn(sessionId, "submitted");
          try {
            const r = await submitVoiceWorkspaceToManagerAgent(
              workspace,
              confirmedTaskMessage(workspace),
              config,
              managerAgentOptions,
            );
            const saved = saveWorkspace(workspace);
            completeTurn(sessionId, saved.progress_brief?.status || "done");
            return { result: r, saved };
          } catch (err) {
            completeTurn(sessionId, "error");
            throw err;
          }
        });
        ok(res, "Voice task submitted to main Agent", {
          workspace: result.saved,
          manager: result.result.manager,
          manager_status: result.result.manager_status,
          spoken_text: result.result.spoken_text,
          voice_events: voiceEvents(result.result.spoken_text, result.result.commentary_texts),
        });
      })
      .catch((err) => {
        if (err instanceof HttpNotFoundError) notFound(res, err.message);
        else if (err instanceof HttpBadRequestError) badRequest(res, err.message);
        else badRequest(res, err instanceof Error ? err.message : "Invalid JSON body");
      });
    return true;
  }

  const confirmStreamMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/confirm\/stream$/);
  if (confirmStreamMatch && method === "POST") {
    readJsonBody(req)
      .then(async () => {
        const sessionId = decodeURIComponent(confirmStreamMatch[1]);
        const config = await readConfig(managerAgentConfigOptions);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        // workspace 在锁内重新读取。
        const result = await withSessionLock(sessionId, async () => {
          const workspace = loadWorkspace(sessionId);
          if (!workspace) {
            streamLine(res, { type: "error", message: "Voice workspace not found" });
            res.end();
            return null;
          }
          reactivateGenerativeUiShadowIfReleased(workspace);
          const streamGenerativeUi = shouldStreamGenerativeUiShadow(workspace);
          let generativeUiCursor = streamGenerativeUi ? activeGenerativeUiCursor(sessionId) : 0;
          workspace.progress_brief = {
            status: "submitted",
            short_text: "已确认，正在交给主 Agent。",
            updated_at: now(),
          };
          streamLine(res, { type: "workspace", phase: "accepted", workspace });
          registerTurn(sessionId, "submitted");
          try {
            const streamedCommentaryTexts = new Set<string>();
            const r = await submitVoiceWorkspaceToManagerAgent(
              workspace,
              confirmedTaskMessage(workspace),
              config,
              managerAgentOptions,
              {
                streamedCommentaryTexts,
                onSpeech: (event) => {
                  const saved = saveWorkspace(workspace);
                  if (streamGenerativeUi) {
                    generativeUiCursor = streamCommittedGenerativeUiTransactions(
                      res,
                      sessionId,
                      generativeUiCursor,
                    );
                  }
                  streamLine(res, { type: "speech", event, workspace: saved });
                },
              },
            );
            const saved = saveWorkspace(workspace);
            if (streamGenerativeUi) {
              generativeUiCursor = streamCommittedGenerativeUiTransactions(
                res,
                sessionId,
                generativeUiCursor,
              );
            }
            completeTurn(sessionId, saved.progress_brief?.status || "done");
            return { result: r, saved };
          } catch (err) {
            completeTurn(sessionId, "error");
            throw err;
          }
        });
        if (!result) return; // workspace not found, already streamed error
        streamLine(res, { type: "workspace", workspace: result.saved });
        for (const event of voiceEvents(result.result.spoken_text, result.result.commentary_texts)) streamLine(res, { type: "speech", event, workspace: result.saved });
        streamLine(res, {
          type: "done",
          workspace: result.saved,
          spoken_text: result.result.spoken_text,
          voice_events: [],
          manager: result.result.manager,
          manager_status: result.result.manager_status,
        });
        res.end();
      })
      .catch((err) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        streamLine(res, { type: "error", message: err instanceof Error ? err.message : "Invalid JSON body" });
        res.end();
      });
    return true;
  }

  const notificationMatch = pathname.match(/^\/api\/voice-agent\/sessions\/([^/]+)\/notifications$/);
  if (notificationMatch && method === "POST") {
    readJsonBody(req)
      .then((body) => {
        const workspace = loadWorkspace(decodeURIComponent(notificationMatch[1]));
        if (!workspace) {
          notFound(res, "Voice workspace not found");
          return;
        }
        const title = typeof body.title === "string" ? body.title : "通知";
        const msg = typeof body.body === "string" ? body.body : "";
        const priority = body.priority === "high" || body.priority === "low" ? body.priority : "normal";
        const spoken = typeof body.spoken_text === "string" && body.spoken_text.trim() ? body.spoken_text.trim() : title;
        workspace.progress_brief = { status: priority === "high" ? "blocked" : "running", short_text: spoken, updated_at: now() };
        appendConversation(
          workspace,
          "assistant",
          msg ? `${spoken}\n${msg}` : spoken,
          "final",
          "message",
          spoken,
        );
        ok(res, "Voice notification queued", { workspace: saveWorkspace(workspace), spoken_text: spoken, voice_events: voiceEvents(spoken) });
      })
      .catch((err) => badRequest(res, err instanceof Error ? err.message : "Invalid JSON body"));
    return true;
  }

  return false;
}

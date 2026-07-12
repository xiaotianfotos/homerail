import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _clearStoredConfig } from "../src/server/voice-agent-bootstrap.js";
import { _clearStoredVoiceSettings } from "../src/server/voice.js";
import { _clearAllSettings, createSetting, upsertProvider } from "../src/persistence/llm-settings.js";
import { createProject } from "../src/persistence/projects-changes.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import { createServer } from "../src/server/http.js";
import {
  buildArkServerResponseForTest,
  extractArkTranscript,
  parseArkVoicePacket,
} from "../src/server/ark-voice.js";
import {
  _setHostCodexManagerAgentRunnerForTest,
  _setHostCodexManagerAgentStreamRunnerForTest,
} from "../src/server/host-codex-manager-agent.js";
import { _clearNodes } from "../src/node/registry.js";
import { managerAgentHostPort, registerFakeDockerNode } from "./helpers/fake-manager-agent-node.js";
import type { CodexModelCatalog } from "../src/server/codex-models.js";

const TEST_CODEX_MODEL_CATALOG: CodexModelCatalog = {
  binary: "codex",
  models: [{
    id: "gpt-5.5",
    model: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "",
    is_default: true,
    default_reasoning_effort: "medium",
    supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
    service_tiers: [],
  }],
};

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("server did not bind");
  return addr.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listenWebSocket(server: WebSocketServer): Promise<number> {
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("websocket server did not bind");
  return addr.port;
}

async function closeWebSocket(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readFirstNdjsonLine(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response body is not readable");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const line = buffer.split("\n").find((item) => item.trim());
  if (!line) throw new Error("no ndjson line received");
  return JSON.parse(line) as Record<string, unknown>;
}

describe("voice bootstrap routes", () => {
  let server: http.Server;
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldLocalNodeAutostart: string | undefined;
  let oldManagerRuntime: string | undefined;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    oldLocalNodeAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    oldManagerRuntime = process.env.HOMERAIL_MANAGER_AGENT_RUNTIME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-voice-bootstrap-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = "container";
    _clearStoredConfig();
    _clearStoredVoiceSettings();
    _clearAllSettings();
    _clearNodes();
    server = createServer(0, undefined, undefined, false, {
      loadCodexModels: async () => TEST_CODEX_MODEL_CATALOG,
      autoDetectCodex: true,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _clearStoredConfig();
    _clearStoredVoiceSettings();
    _clearAllSettings();
    _clearNodes();
    _setHostCodexManagerAgentRunnerForTest();
    _setHostCodexManagerAgentStreamRunnerForTest();
    await close(server);
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldLocalNodeAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = oldLocalNodeAutostart;
    if (oldManagerRuntime === undefined) delete process.env.HOMERAIL_MANAGER_AGENT_RUNTIME;
    else process.env.HOMERAIL_MANAGER_AGENT_RUNTIME = oldManagerRuntime;
    delete process.env.HOMERAIL_MIMO_API_KEY;
    delete process.env.HOMERAIL_TTS_API_KEY;
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("extracts Doubao Speech ASR full text without word-level duplicates", () => {
    expect(extractArkTranscript([
      {
        result: {
          text: "你好，这是一个豆包语音识别测试。",
          utterances: [
            {
              text: "你好，这是一个豆包语音识别测试。",
              words: [{ text: "你" }, { text: "好" }],
            },
          ],
        },
      },
    ])).toBe("你好，这是一个豆包语音识别测试。");
  });

  it("keeps voice-agent config readable without creating workspaces", async () => {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/voice-agent/config`);
    const body = await response.json() as {
      success: boolean;
      data: { agent_type: string; harness: string; model_name: string; reasoning_effort: string };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      agent_type: "manager_agent",
      harness: "codex_appserver",
      model_name: "gpt-5.5",
      reasoning_effort: "medium",
    });
  });

  it("keeps an available user-configured Claude SDK runtime ahead of Codex auto-detection", async () => {
    upsertProvider({
      id: "claude-priority",
      name: "Claude Priority",
      default_model: "claude-priority-model",
      base_url: "https://claude-priority.example/v1",
      anthropic_base_url: "https://claude-priority.example/v1",
    });
    const setting = createSetting({
      provider_id: "claude-priority",
      endpoint_id: "custom",
      model_name: "claude-priority-model",
      api_key: "sk-claude-priority",
      protocol: "anthropic_compatible",
      base_url: "https://claude-priority.example/v1",
      anthropic_base_url: "https://claude-priority.example/v1",
      supports_llm: true,
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);

    const response = await fetch(`http://127.0.0.1:${port}/api/manager-agent/config`);
    const body = await response.json() as {
      data: { harness: string; llm_setting_id: string; model_name: string };
    };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      harness: "claude_agent_sdk",
      llm_setting_id: setting.id,
      model_name: "claude-priority-model",
    });
  });

  it("rejects unsupported Codex reasoning efforts through the legacy config route without persisting", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness: "codex_appserver",
        model_name: "gpt-5.5",
        reasoning_effort: "minimal",
      }),
    });
    const body = await response.json() as { success: boolean; error: string };

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: "Codex model 'gpt-5.5' does not support reasoning effort 'minimal'. Supported values: low, medium, high, xhigh.",
    });
    expect(getDb()
      .prepare("SELECT id FROM manager_agent_config WHERE id = ?")
      .get("default"))
      .toBeUndefined();
  });

  it("stores and returns the current-session pointer for cross-device sync", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    // Initially null.
    const initial = await fetch(`${baseUrl}/api/voice-agent/current-session`);
    const initialBody = await initial.json();
    expect(initialBody.success).toBe(true);
    expect(initialBody.data.session_id).toBeNull();

    // Create a session, set it as current.
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: null }),
    });
    const createdBody = await created.json();
    const sessionId = createdBody.data.session_id;

    const put = await fetch(`${baseUrl}/api/voice-agent/current-session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const putBody = await put.json();
    expect(putBody.success).toBe(true);
    expect(putBody.data.session_id).toBe(sessionId);

    // GET returns the stored pointer.
    const got = await fetch(`${baseUrl}/api/voice-agent/current-session`);
    const gotBody = await got.json();
    expect(gotBody.data.session_id).toBe(sessionId);

    // Clearing the pointer.
    const cleared = await fetch(`${baseUrl}/api/voice-agent/current-session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: null }),
    });
    const clearedBody = await cleared.json();
    expect(clearedBody.data.session_id).toBeNull();
  });

  it("exposes Widget File Protocol operations through internal voice routes", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const example = await fetch(`${baseUrl}/api/voice-agent/widget-files/example`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widget_type: "checklist" }),
    });
    const exampleBody = await example.json() as { data: { toml: string } };
    expect(example.status).toBe(200);
    expect(exampleBody.data.toml).toContain("widget_type");

    const validate = await fetch(`${baseUrl}/api/voice-agent/widget-files/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widget_type: "checklist", toml: exampleBody.data.toml }),
    });
    const validateBody = await validate.json() as { data: { ok: boolean } };
    expect(validateBody.data.ok).toBe(true);

    const write = await fetch(`${baseUrl}/api/voice-agent/widget-files/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "voice-widget-route-test",
        widget_id: "checklist",
        widget_type: "checklist",
        toml: exampleBody.data.toml,
      }),
    });
    const writeBody = await write.json() as { data: { ok: boolean; widget: { id: string } } };
    expect(write.status).toBe(200);
    expect(writeBody.data.ok).toBe(true);
    expect(writeBody.data.widget.id).toBe("review-checklist");

    const read = await fetch(`${baseUrl}/api/voice-agent/widget-files/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "voice-widget-route-test", widget_id: "checklist" }),
    });
    const readBody = await read.json() as { data: { ok: boolean; widget: { id: string } } };
    expect(readBody.data.ok).toBe(true);
    expect(readBody.data.widget.id).toBe("review-checklist");

    const remove = await fetch(`${baseUrl}/api/voice-agent/widget-files/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "voice-widget-route-test", widget_id: "checklist" }),
    });
    const removeBody = await remove.json() as { data: { removed: boolean; widget_id: string } };
    expect(removeBody.data).toMatchObject({ removed: true, widget_id: "checklist" });

    const memo = await fetch(`${baseUrl}/api/voice-agent/widget-files/voice-memo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "voice-widget-route-test",
        title: "任务记录",
        status: "clarifying",
        summary: "需要补充目标",
      }),
    });
    const memoBody = await memo.json() as { data: { ok: boolean; widget_id: string; status: string; widget: { id: string } } };
    expect(memo.status).toBe(200);
    expect(memoBody.data).toMatchObject({
      ok: true,
      widget_id: "voice-memo",
      status: "clarifying",
    });
    expect(memoBody.data.widget.id).toBe("voice-memo");
  });

  it("treats voice-agent config as a compatibility alias for main Manager Agent config", async () => {
    let seenReasoningEffort: string | null | undefined;
    _setHostCodexManagerAgentRunnerForTest(async (input) => {
      seenReasoningEffort = input.agent_config.reasoning_effort;
      return {
        text: "主 Agent 已按服务端配置处理。",
        spoken_text: "已处理。",
        session_id: input.session_id || "host-session-main-config",
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: [],
        tool_results: [],
        commentary_texts: [],
        voice_surface: { progress: null, task_draft: null, widgets: [], remove_widget_ids: [] },
        worker_id: "host-codex",
        container_name: null,
      };
    });

    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const legacySave = await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "medium" }),
    });
    expect(legacySave.status).toBe(200);

    const managerAfterLegacy = await fetch(`${baseUrl}/api/manager-agent/config`);
    const managerAfterLegacyBody = await managerAfterLegacy.json() as { data: { harness: string; reasoning_effort: string } };
    expect(managerAfterLegacyBody.data).toMatchObject({ harness: "codex_appserver", reasoning_effort: "medium" });
    const legacyMirror = getDb()
      .prepare("SELECT id FROM voice_agent_config WHERE id = ?")
      .get("default");
    expect(legacyMirror).toBeUndefined();

    const managerSave = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "xhigh" }),
    });
    expect(managerSave.status).toBe(200);

    const voiceAfterManager = await fetch(`${baseUrl}/api/voice-agent/config`);
    const voiceAfterManagerBody = await voiceAfterManager.json() as { data: { harness: string; reasoning_effort: string } };
    expect(voiceAfterManagerBody.data).toMatchObject({ harness: "codex_appserver", reasoning_effort: "xhigh" });

    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "按当前主 Agent 配置回复。" }),
    });

    expect(turn.status).toBe(200);
    expect(seenReasoningEffort).toBe("xhigh");
  });

  it("creates and processes a voice-agent workspace", async () => {
    await close(server);
    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p1" }),
    });
    const body = await response.json() as { success: boolean; data: { session_id: string; pending_confirmations: unknown[] } };

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.session_id).toMatch(/^voice-/);

    const emptyList = await fetch(`http://127.0.0.1:${port}/api/voice-agent/sessions?project_id=p1&limit=5`);
    const emptyListBody = await emptyList.json() as { data: { sessions: Array<{ session_id: string; title?: string | null; prompt?: string | null }> } };
    expect(emptyListBody.data.sessions).toContainEqual(expect.objectContaining({
      session_id: body.data.session_id,
      title: null,
      prompt: null,
    }));

    const turn = await fetch(`http://127.0.0.1:${port}/api/voice-agent/sessions/${body.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "帮我整理一个开源检查任务。第二句不要做标题" }),
    });
    const turnBody = await turn.json() as {
      success: boolean;
      data: {
        suggested_action: string | null;
        spoken_text: string;
        workspace: {
          pending_confirmations: unknown[];
          progress_brief: { status: string };
          debug_events: Array<{ code: string }>;
          widgets: Array<{ id: string }>;
        };
      };
    };

    expect(turn.status).toBe(200);
    expect(turnBody.success).toBe(true);
    expect(turnBody.data.suggested_action).toBeNull();
    expect(turnBody.data.spoken_text).toContain("主 Agent 执行入口不可用");
    expect(turnBody.data.workspace.pending_confirmations).toHaveLength(0);
    expect(turnBody.data.workspace.progress_brief.status).toBe("error");
    expect(turnBody.data.workspace.debug_events).toContainEqual(expect.objectContaining({ code: "manager_agent_unavailable" }));
    expect(turnBody.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-agent-blocker" }));
    expect(turnBody.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-run" }));

    const titledList = await fetch(`http://127.0.0.1:${port}/api/voice-agent/sessions?project_id=p1&limit=5`);
    const titledListBody = await titledList.json() as { data: { sessions: Array<{ session_id: string; title?: string | null }> } };
    expect(titledListBody.data.sessions).toContainEqual(expect.objectContaining({
      session_id: body.data.session_id,
      title: "帮我整理一个开源检查任务",
    }));

    const stream = await fetch(`http://127.0.0.1:${port}/api/voice-agent/sessions/${body.data.session_id}/turn/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "现在状态怎么样" }),
    });
    const streamText = await stream.text();
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("application/x-ndjson");
    expect(streamText).toContain("\"type\":\"done\"");

    const confirm = await fetch(`http://127.0.0.1:${port}/api/voice-agent/sessions/${body.data.session_id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation_id: "submit-task" }),
    });
    const confirmBody = await confirm.json() as { success: boolean; data: { spoken_text: string; manager: { code?: string } } };
    expect(confirm.status).toBe(200);
    expect(confirmBody.success).toBe(true);
    expect(confirmBody.data.spoken_text).toContain("主 Agent 执行入口不可用");
    expect(confirmBody.data.manager.code).toBe("manager_agent_unavailable");
  });

  it("strips legacy programmatic status widgets when loading a voice workspace", async () => {
    const port = await listen(server);
    const response = await fetch(`http://127.0.0.1:${port}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p1" }),
    });
    const body = await response.json() as { data: { session_id: string; widgets: Array<Record<string, unknown>> } };
    const agentWidget = {
      id: "agent-generated-plan",
      type: "list",
      title: "执行计划",
      body: "由 Agent 生成",
      priority: "normal",
      items: ["检查代码"],
      steps: [],
      data: {},
    };
    getDb()
      .prepare("UPDATE voice_agent_sessions SET data = ? WHERE session_id = ?")
      .run(JSON.stringify({
        ...body.data,
        widgets: [
          {
            id: "manager-agent-blocker",
            type: "status",
            title: "主 Agent 阻塞",
            body: "旧的程序化状态卡",
            priority: "high",
            items: [],
            steps: [],
            data: {},
          },
          {
            id: "manager-run",
            type: "status",
            title: "主 Agent 执行中",
            body: "旧的程序化状态卡",
            priority: "normal",
            items: [],
            steps: [],
            data: {},
          },
          agentWidget,
        ],
      }), body.data.session_id);

    const loaded = await fetch(`http://127.0.0.1:${port}/api/voice-agent/sessions/${body.data.session_id}`);
    const loadedBody = await loaded.json() as { data: { widgets: Array<{ id: string }> } };

    expect(loaded.status).toBe(200);
    expect(loadedBody.data.widgets).toContainEqual(expect.objectContaining({ id: "agent-generated-plan" }));
    expect(loadedBody.data.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-agent-blocker" }));
    expect(loadedBody.data.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-run" }));
  });

  it("snapshots editable voice UI rules when the voice session is created", async () => {
    const userRuleDir = path.join(tmpHome, "asset", "voice-agent");
    fs.mkdirSync(userRuleDir, { recursive: true });
    fs.writeFileSync(path.join(userRuleDir, "ui-rules.md"), "SESSION_RULE_A_DO_NOT_RELOAD", "utf8");

    let seenRulesPrompt = "";
    let seenRulesHash = "";
    _setHostCodexManagerAgentRunnerForTest(async (input) => {
      seenRulesPrompt = input.voice_ui_rules?.prompt ?? "";
      seenRulesHash = input.voice_ui_rules?.hash ?? "";
      return {
        text: "已按当前规则处理。",
        spoken_text: "已按当前规则处理。",
        session_id: input.session_id || "host-session-rules",
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: [],
        tool_results: [],
        commentary_texts: [],
        voice_surface: { progress: null, task_draft: null, widgets: [], remove_widget_ids: [] },
        effective_config: {
          harness: "host_codex",
          response_mode: "voice",
          provider: "codex",
          model: "gpt-5.5",
          reasoning_effort: input.agent_config.reasoning_effort ?? null,
          workspace: "/tmp/workspace",
          voice_ui_rules_hash: input.voice_ui_rules?.hash ?? null,
          voice_ui_rules_sources: input.voice_ui_rules?.sources ?? [],
        },
        worker_id: "host-codex",
        container_name: null,
      };
    });

    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });

    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p-rules" }),
    });
    const createdBody = await created.json() as {
      data: {
        session_id: string;
        voice_ui_rules: { hash: string; prompt_path: string; sources: string[] };
      };
    };
    const firstSnapshot = fs.readFileSync(createdBody.data.voice_ui_rules.prompt_path, "utf8");
    expect(firstSnapshot).toContain("SESSION_RULE_A_DO_NOT_RELOAD");
    expect(createdBody.data.voice_ui_rules.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(createdBody.data.voice_ui_rules.sources.some((source) => source.includes("ui-rules.md"))).toBe(true);

    fs.writeFileSync(path.join(userRuleDir, "ui-rules.md"), "SESSION_RULE_B_NEW_SESSION_ONLY", "utf8");
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "看看规则快照。" }),
    });
    expect(turn.status).toBe(200);
    expect(seenRulesPrompt).toContain("SESSION_RULE_A_DO_NOT_RELOAD");
    expect(seenRulesPrompt).not.toContain("SESSION_RULE_B_NEW_SESSION_ONLY");
    expect(seenRulesHash).toBe(createdBody.data.voice_ui_rules.hash);

    const next = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p-rules" }),
    });
    const nextBody = await next.json() as { data: { voice_ui_rules: { prompt_path: string } } };
    const secondSnapshot = fs.readFileSync(nextBody.data.voice_ui_rules.prompt_path, "utf8");
    expect(secondSnapshot).toContain("SESSION_RULE_B_NEW_SESSION_ONLY");
    expect(secondSnapshot).not.toContain("SESSION_RULE_A_DO_NOT_RELOAD");
  });

  it("passes the selected project workspace to host Codex voice turns", async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-voice-selected-workspace-"));
    let seenWorkspace: string | undefined;
    _setHostCodexManagerAgentRunnerForTest(async (input) => {
      seenWorkspace = input.agent_config.project_workspace;
      return {
        text: `当前目录是 ${seenWorkspace}`,
        spoken_text: `当前目录是 ${seenWorkspace}`,
        session_id: input.session_id || "host-session-workspace",
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: [],
        tool_results: [],
        commentary_texts: [],
        voice_surface: { progress: null, task_draft: null, widgets: [], remove_widget_ids: [] },
        effective_config: {
          harness: "host_codex",
          response_mode: "voice",
          provider: "codex",
          model: "gpt-5.5",
          reasoning_effort: input.agent_config.reasoning_effort ?? null,
          workspace: seenWorkspace ?? null,
          voice_ui_rules_hash: input.voice_ui_rules?.hash ?? null,
          voice_ui_rules_sources: input.voice_ui_rules?.sources ?? [],
        },
        worker_id: "host-codex",
        container_name: null,
      };
    });
    try {
      const port = await listen(server);
      const baseUrl = `http://127.0.0.1:${port}`;
      await fetch(`${baseUrl}/api/voice-agent/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
      });

      const project = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Selected Workspace", workspace_path: workspaceDir }),
      });
      const projectBody = await project.json() as { data: { id: string } };

      const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectBody.data.id }),
      });
      const createdBody = await created.json() as {
        data: { session_id: string; project_workspace_path: string | null };
      };
      expect(created.status).toBe(201);
      expect(createdBody.data.project_workspace_path).toBe(workspaceDir);

      const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "看看你现在当前在什么目录？" }),
      });
      const body = await turn.json() as {
        data: {
          manager: { effective_config?: { workspace?: string | null } };
          workspace: { project_workspace_path: string | null };
        };
      };

      expect(turn.status).toBe(200);
      expect(seenWorkspace).toBe(workspaceDir);
      expect(body.data.manager.effective_config?.workspace).toBe(workspaceDir);
      expect(body.data.workspace.project_workspace_path).toBe(workspaceDir);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("exposes the editable user voice UI rules asset", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const assetPath = path.join(tmpHome, "asset", "voice-agent", "ui-rules.md");

    const initial = await fetch(`${baseUrl}/api/voice-agent/ui-rules`);
    const initialBody = await initial.json() as {
      data: {
        path: string;
        exists: boolean;
        content: string;
        template: string;
        effective_sources: string[];
      };
    };
    expect(initial.status).toBe(200);
    expect(initialBody.data.path).toBe(assetPath);
    expect(initialBody.data.exists).toBe(false);
    expect(initialBody.data.content).toBe("");
    expect(initialBody.data.template).toContain("Voice Agent UI Rules");
    expect(fs.existsSync(assetPath)).toBe(false);

    const created = await fetch(`${baseUrl}/api/voice-agent/ui-rules?create=1`);
    const createdBody = await created.json() as { data: { exists: boolean; content: string } };
    expect(created.status).toBe(200);
    expect(createdBody.data.exists).toBe(true);
    expect(createdBody.data.content).toContain("voice-memo");
    expect(fs.existsSync(assetPath)).toBe(true);

    const customRule = "CUSTOM_UI_RULE_FOR_NEXT_SESSION";
    const saved = await fetch(`${baseUrl}/api/voice-agent/ui-rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: customRule }),
    });
    const savedBody = await saved.json() as { data: { exists: boolean; content: string; effective_sources: string[] } };
    expect(saved.status).toBe(200);
    expect(savedBody.data.exists).toBe(true);
    expect(savedBody.data.content).toBe(customRule);
    expect(savedBody.data.effective_sources.some((source) => source.startsWith(`user:${assetPath}`))).toBe(true);

    const session = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const sessionBody = await session.json() as { data: { voice_ui_rules: { prompt_path: string } } };
    const snapshot = fs.readFileSync(sessionBody.data.voice_ui_rules.prompt_path, "utf8");
    expect(snapshot).toContain(customRule);
  });

  it("keeps project_id from stream turns when the workspace was created without one", async () => {
    await close(server);
    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json() as { data: { session_id: string; project_id: string | null } };
    expect(createdBody.data.project_id).toBeNull();

    const stream = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p-stream", text: "帮我整理一个测试任务" }),
    });
    const lines = (await stream.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; workspace?: { project_id?: string | null } });
    const done = lines.find((line) => line.type === "done");

    expect(stream.status).toBe(200);
    expect(done?.workspace?.project_id).toBe("p-stream");

    const listed = await fetch(`${baseUrl}/api/voice-agent/sessions?project_id=p-stream&limit=5`);
    const listedBody = await listed.json() as { data: { sessions: Array<{ session_id: string; project_id: string }> } };
    expect(listedBody.data.sessions).toContainEqual(expect.objectContaining({
      session_id: createdBody.data.session_id,
      project_id: "p-stream",
    }));
  });

  it("streams an accepted workspace event before the Manager Agent turn finishes", async () => {
    let releaseRunner: (() => void) | null = null;
    _setHostCodexManagerAgentRunnerForTest(async (input) => {
      await new Promise<void>((resolve) => {
        releaseRunner = resolve;
      });
      return {
        text: `handled ${input.message}`,
        spoken_text: "处理完成。",
        session_id: input.session_id || "host-session-stream",
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: [],
        tool_results: [],
        worker_id: "host-codex",
        container_name: null,
      };
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p-stream-accepted" }),
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const stream = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "帮我先记一下这个需求" }),
    });
    const first = await readFirstNdjsonLine(stream);

    releaseRunner?.();
    expect(stream.status).toBe(200);
    expect(first).toMatchObject({
      type: "workspace",
      phase: "accepted",
      workspace: {
        session_id: createdBody.data.session_id,
        project_id: "p-stream-accepted",
        progress_brief: {
          status: "running",
          short_text: "正在交给主 Agent。",
        },
      },
    });
  });

  it("streams Manager Agent commentary before the final done event", async () => {
    _setHostCodexManagerAgentStreamRunnerForTest(async function* (input) {
      yield { type: "commentary", text: "正在检查项目。", source: "tool" };
      yield {
        type: "result",
        result: {
          text: `handled ${input.message}`,
          spoken_text: "处理完成。",
          commentary_texts: ["正在检查项目。"],
          session_id: input.session_id || "host-session-stream",
          run_id: null,
          run_ids: [],
          objective: { required: false, satisfied: true, tool_calls: [] },
          tool_calls: [],
          tool_results: [],
          worker_id: "host-codex",
          container_name: null,
        },
      };
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p-stream-commentary" }),
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const stream = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "帮我实时说明进度" }),
    });
    const lines = (await stream.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; event?: { channel?: string; text?: string } });
    const commentaryIndex = lines.findIndex((line) => line.type === "speech" && line.event?.channel === "commentary");
    const doneIndex = lines.findIndex((line) => line.type === "done");
    const commentaryEvents = lines.filter((line) => line.type === "speech" && line.event?.channel === "commentary");

    expect(stream.status).toBe(200);
    expect(commentaryIndex).toBeGreaterThan(-1);
    expect(doneIndex).toBeGreaterThan(commentaryIndex);
    expect(commentaryEvents).toHaveLength(1);
    expect(commentaryEvents[0]?.event?.text).toBe("正在检查项目。");
  });

  it("persists manager-agent voice errors as failed sessions instead of throwing status errors", async () => {
    await close(server);
    server = createServer(0);
    createSetting({
      provider_id: "kimi",
      endpoint_id: "kimi_coding_plan",
      model_name: "kimi-k2.7-code",
      api_key: "pk-test-voice-manager",
      supports_llm: true,
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p-manager-error" }),
    });
    const createdBody = await created.json() as { data: { session_id: string } };

    const stream = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "请回复收到，别执行任何操作。" }),
    });
    const streamText = await stream.text();
    const row = getDb()
      .prepare("SELECT status, message_count FROM sessions WHERE session_id = ?")
      .get(createdBody.data.session_id) as { status: string; message_count: number };

    expect(stream.status).toBe(200);
    expect(streamText).toContain("主 Agent 执行失败");
    expect(streamText).not.toContain("Invalid session status: error");
    expect(row.status).toBe("failed");
    expect(row.message_count).toBe(2);
  });

  it("serves voice model and connection endpoints without requiring local defaults", async () => {
    const port = await listen(server);

    for (const endpoint of ["/api/voice/models", "/api/voice/test"]) {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json() as { success: boolean; data?: { models?: unknown[] } };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data?.models).toEqual(expect.any(Array));
    }

    const speech = await fetch(`http://127.0.0.1:${port}/api/voice/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(speech.status).toBe(502);
    expect(await speech.text()).toContain("Missing TTS API key");
  });

  it("forwards speech to a configured MiMo TTS setting instead of returning silent audio", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    await fetch(`${baseUrl}/api/llm-settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "xiaomi",
        model_name: "mimo-v2.5-tts",
        api_key: "tts-secret-12345678",
        base_url: "https://api.xiaomimimo.com",
        supports_llm: false,
        supports_tts: true,
      }),
    });

    const originalFetch = globalThis.fetch;
    const upstreamCalls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.startsWith(baseUrl)) {
        return originalFetch(input, init);
      }
      upstreamCalls.push([url, init]);
      return new Response(JSON.stringify({
        choices: [{ message: { audio: { data: Buffer.from("RIFF----WAVEdata").toString("base64") } } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const speech = await fetch(`${baseUrl}/api/voice/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "播报当前状态" }),
    });
    expect(speech.status).toBe(200);
    expect(speech.headers.get("content-type")).toContain("audio/wav");
    const wav = Buffer.from(await speech.arrayBuffer());
    expect(wav.subarray(0, 4).toString("utf-8")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("utf-8")).toBe("WAVE");
    expect(upstreamCalls).toHaveLength(1);
    const [url, init] = upstreamCalls[0];
    expect(url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect((init?.headers as Record<string, string>)["api-key"]).toBe("tts-secret-12345678");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "mimo-v2.5-tts",
      messages: [
        { role: "user", content: "Read the assistant message aloud in the specified voice." },
        { role: "assistant", content: "播报当前状态" },
      ],
      audio: { format: "wav", voice: "mimo_default" },
    });
  });

  it("uses explicit HTTP endpoints for custom OpenAI-compatible ASR and TTS settings", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    upsertProvider({
      id: "custom-audio-test",
      name: "Custom Audio Test",
      default_model: "local-audio",
      base_url: "http://voice.test/v1",
      supports_llm: false,
      supports_asr: true,
      supports_tts: true,
    });
    const setting = createSetting({
      provider_id: "custom-audio-test",
      model_name: "local-audio",
      api_key: "local-no-key",
      base_url: "http://voice.test/v1",
      voice_adapter: "openai_audio",
      tts_http_url: "http://voice.test/custom-speech",
      asr_async_url: "http://voice.test/custom-transcriptions",
      asr_realtime_url: "ws://voice.test/custom-realtime",
      supports_llm: false,
      supports_asr: true,
      supports_tts: true,
    });
    await fetch(`${baseUrl}/api/voice`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asr_llm_setting_id: setting.id,
        tts_llm_setting_id: setting.id,
      }),
    });

    const originalFetch = globalThis.fetch;
    const upstreamUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.startsWith(baseUrl)) return originalFetch(input, init);
      upstreamUrls.push(url);
      if (url.endsWith("custom-transcriptions")) {
        return new Response(JSON.stringify({ text: "custom transcript" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(Buffer.from("custom speech"), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    });

    const speech = await fetch(`${baseUrl}/api/voice/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(speech.status).toBe(200);

    const transcribe = await fetch(`${baseUrl}/api/voice/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_data_url: `data:audio/wav;base64,${Buffer.from("audio").toString("base64")}`,
      }),
    });
    const transcribeBody = await transcribe.json() as { data?: { text?: string } };
    expect(transcribe.status).toBe(200);
    expect(transcribeBody.data?.text).toBe("custom transcript");
    expect(upstreamUrls).toEqual([
      "http://voice.test/custom-speech",
      "http://voice.test/custom-transcriptions",
    ]);
  });

  it("routes Doubao Speech TTS through the openspeech adapter instead of OpenAI audio speech", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const upstreamHeaders: http.IncomingHttpHeaders[] = [];
    const upstreamRequests: unknown[] = [];
    const upstream = http.createServer((req, res) => {
      upstreamHeaders.push(req.headers);
      let body = "";
      req.setEncoding("utf-8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        upstreamRequests.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.end(`${JSON.stringify({
          code: 20000000,
          data: Buffer.from("ark-tts-audio").toString("base64"),
        })}\n`);
      });
    });
    const upstreamPort = await listen(upstream);

    try {
      upsertProvider({
        id: "ark-voice-test",
        name: "Doubao Speech Test",
        default_model: "doubao-seed-tts-2.0",
        base_url: "https://openspeech.bytedance.com/api/v3",
        supports_llm: false,
        supports_tts: true,
      });
      const setting = createSetting({
        provider_id: "ark-voice-test",
        endpoint_id: "ark-voice-test_custom",
        model_name: "doubao-seed-tts-2.0",
        api_key: "openspeech-secret-tts",
        protocol: "volcengine_openspeech",
        auth_type: "x-api-key",
        base_url: "https://openspeech.bytedance.com/api/v3",
        resource_id: "seed-tts-2.0",
        voice_adapter: "volcengine_openspeech",
        tts_http_url: `http://127.0.0.1:${upstreamPort}/tts/unidirectional`,
        tts_voice: "zh_female_vv_uranus_bigtts",
        tts_format: "mp3",
        tts_sample_rate: 24000,
        supports_llm: false,
        supports_tts: true,
      });
      await fetch(`${baseUrl}/api/voice`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tts_llm_setting_id: setting.id,
          tts_voice: "zh_female_shuangkuaisisi_moon_bigtts",
        }),
      });

      const speech = await fetch(`${baseUrl}/api/voice/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "播报火山语音状态" }),
      });

      expect(speech.status).toBe(200);
      expect(speech.headers.get("content-type")).toContain("audio/mpeg");
      expect(Buffer.from(await speech.arrayBuffer()).toString("utf-8")).toBe("ark-tts-audio");
      expect(upstreamHeaders).toHaveLength(1);
      expect(upstreamHeaders[0]["x-api-key"]).toBe("openspeech-secret-tts");
      expect(upstreamHeaders[0]["x-api-resource-id"]).toBe("seed-tts-2.0");
      expect(upstreamHeaders[0]["x-api-request-id"]).toEqual(expect.any(String));
      expect(upstreamRequests[0]).toMatchObject({
        req_params: {
          speaker: "zh_female_vv_uranus_bigtts",
          text: "播报火山语音状态",
          audio_params: { format: "mp3", sample_rate: 24000 },
        },
      });
      expect(upstreamRequests[0]).not.toHaveProperty("namespace");
    } finally {
      await close(upstream);
    }
  });

  it("returns catalog models for openspeech voice model probes without calling /v1/models", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    let upstreamCalls = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "openspeech does not expose /v1/models" }));
    });
    const upstreamPort = await listen(upstream);

    try {
      upsertProvider({
        id: "ark-voice-model-probe-test",
        name: "Ark Voice Model Probe Test",
        default_model: "doubao-seed-tts-2.0",
        base_url: `http://127.0.0.1:${upstreamPort}`,
        supports_llm: false,
        supports_tts: true,
        supports_asr: true,
      });
      const setting = createSetting({
        provider_id: "ark-voice-model-probe-test",
        endpoint_id: "ark-voice-model-probe-test_custom",
        model_name: "doubao-seed-tts-2.0",
        api_key: "openspeech-secret-probe",
        protocol: "volcengine_openspeech",
        auth_type: "x-api-key",
        base_url: `http://127.0.0.1:${upstreamPort}`,
        resource_id: "seed-tts-2.0",
        voice_adapter: "volcengine_openspeech",
        supports_llm: false,
        supports_tts: true,
        supports_asr: true,
        supports_audio_input: true,
      });

      const ttsModels = await fetch(`${baseUrl}/api/voice/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "tts", llm_setting_id: setting.id }),
      });
      const ttsBody = await ttsModels.json() as { data?: { models?: string[] } };
      expect(ttsModels.status).toBe(200);
      expect(ttsBody.data?.models).toEqual(["doubao-seed-tts-2.0"]);

      const asrTest = await fetch(`${baseUrl}/api/voice/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: "asr", llm_setting_id: setting.id }),
      });
      const asrBody = await asrTest.json() as {
        message?: string;
        data?: {
          models?: string[];
          verified?: boolean;
          verification_status?: string;
          warning?: string;
        };
      };
      expect(asrTest.status).toBe(200);
      expect(asrBody.message).toBe("Voice connection not verified");
      expect(asrBody.data?.models).toEqual(["doubao-seed-asr-2.0", "doubao-bigasr-1.0"]);
      expect(asrBody.data?.verified).toBe(false);
      expect(asrBody.data?.verification_status).toBe("not_verified");
      expect(asrBody.data?.warning).toContain("密钥将在实际 ASR/TTS 调用时验证");
      expect(upstreamCalls).toBe(0);
    } finally {
      await close(upstream);
    }
  });

  it("passes through Doubao Speech TTS upstream auth failure messages", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        header: {
          reqid: "upstream-request-id",
          code: 45000010,
          message: "Invalid X-Api-Key",
        },
      }));
    });
    const upstreamPort = await listen(upstream);

    try {
      upsertProvider({
        id: "ark-voice-auth-test",
        name: "Doubao Speech Auth Test",
        default_model: "doubao-seed-tts-2.0",
        base_url: "https://openspeech.bytedance.com/api/v3",
        supports_llm: false,
        supports_tts: true,
      });
      const setting = createSetting({
        provider_id: "ark-voice-auth-test",
        endpoint_id: "ark-voice-auth-test_custom",
        model_name: "doubao-seed-tts-2.0",
        api_key: "invalid-openspeech-secret",
        protocol: "volcengine_openspeech",
        auth_type: "x-api-key",
        base_url: "https://openspeech.bytedance.com/api/v3",
        resource_id: "seed-tts-2.0",
        voice_adapter: "volcengine_openspeech",
        tts_http_url: `http://127.0.0.1:${upstreamPort}/tts/unidirectional`,
        tts_voice: "zh_female_vv_uranus_bigtts",
        supports_llm: false,
        supports_tts: true,
      });
      await fetch(`${baseUrl}/api/voice`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tts_llm_setting_id: setting.id }),
      });

      const speech = await fetch(`${baseUrl}/api/voice/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "播报火山语音状态" }),
      });
      const body = await speech.json() as { success: boolean; message: string };

      expect(speech.status).toBe(502);
      expect(body.success).toBe(false);
      expect(body.message).toBe("Invalid X-Api-Key");
      expect(body.message).not.toContain("连接已关闭");
      expect(body.message).not.toContain("Unexpected server response");
      expect(body.message).not.toContain("火山方舟模型 API Key");
    } finally {
      await close(upstream);
    }
  });

  it("routes Doubao Speech ASR through the openspeech adapter instead of OpenAI transcriptions", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const upstreamPort = await listenWebSocket(upstream);
    const upstreamHeaders: http.IncomingHttpHeaders[] = [];
    const upstreamPayloads: unknown[] = [];
    upstream.on("connection", (socket, req) => {
      upstreamHeaders.push(req.headers);
      socket.once("message", (data) => {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        upstreamPayloads.push(parseArkVoicePacket(buffer).payload);
        socket.send(buildArkServerResponseForTest({ text: "火山转写成功" }, -1));
      });
    });

    try {
      upsertProvider({
        id: "ark-asr-test",
        name: "Ark ASR Test",
        default_model: "doubao-seed-asr-2.0",
        base_url: "https://openspeech.bytedance.com/api/v3",
        supports_llm: false,
        supports_asr: true,
        supports_audio_input: true,
      });
      const setting = createSetting({
        provider_id: "ark-asr-test",
        endpoint_id: "ark-asr-test_custom",
        model_name: "doubao-seed-asr-2.0",
        api_key: "openspeech-secret-asr",
        protocol: "volcengine_ark_voice",
        auth_type: "x-api-key",
        base_url: "https://openspeech.bytedance.com/api/v3",
        resource_id: "volc.seedasr.sauc.duration",
        voice_adapter: "volcengine_ark_voice",
        asr_realtime_url: `ws://127.0.0.1:${upstreamPort}`,
        supports_llm: false,
        supports_asr: true,
        supports_audio_input: true,
      });
      await fetch(`${baseUrl}/api/voice`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asr_llm_setting_id: setting.id }),
      });

      const audioDataUrl = `data:audio/wav;base64,${Buffer.from("pcm-audio").toString("base64")}`;
      const response = await fetch(`${baseUrl}/api/voice/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_data_url: audioDataUrl, mode: "asr" }),
      });
      const body = await response.json() as { success: boolean; data?: { text?: string } };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data?.text).toBe("火山转写成功");
      expect(upstreamHeaders).toHaveLength(1);
      expect(upstreamHeaders[0]["x-api-key"]).toBe("openspeech-secret-asr");
      expect(upstreamHeaders[0]["x-api-resource-id"]).toBe("volc.seedasr.sauc.duration");
      expect(upstreamPayloads[0]).toMatchObject({
        audio: {
          format: "pcm",
          codec: "raw",
          rate: 16000,
          bits: 16,
          channel: 1,
        },
      });
    } finally {
      await closeWebSocket(upstream);
    }
  });

  it("emulates realtime ASR over the backend WebSocket for a configured MiMo ASR setting", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    await fetch(`${baseUrl}/api/llm-settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_id: "xiaomi",
        model_name: "mimo-v2.5-asr",
        api_key: "asr-secret-12345678",
        supports_llm: false,
        supports_asr: true,
        supports_audio_input: true,
      }),
    });

    const originalFetch = globalThis.fetch;
    const upstreamCalls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.startsWith(baseUrl)) {
        return originalFetch(input, init);
      }
      upstreamCalls.push([url, init]);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "实时转写成功" } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice/asr/realtime`);
    const done = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for ASR done")), 5_000);
      ws.on("open", () => {
        ws.send(Buffer.from([0, 0, 12, 0, 24, 0, 12, 0]));
        ws.send(JSON.stringify({ type: "finish" }));
      });
      ws.on("message", (data) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === "error") {
          clearTimeout(timer);
          reject(new Error(String(event.error)));
        }
        if (event.type === "transcription.done") {
          clearTimeout(timer);
          resolve(event);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    }).finally(() => ws.close());

    expect(done).toMatchObject({
      type: "transcription.done",
      strategy: "emulated_batch",
      text: "实时转写成功",
      transcript: "实时转写成功",
    });
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0][0]).toBe("https://api.xiaomimimo.com/v1/chat/completions");
  });

  it("routes codex_appserver voice turns through the real Manager Agent handoff", async () => {
    _setHostCodexManagerAgentRunnerForTest(async (input) => ({
      text: `host codex handled: ${input.message}`,
      session_id: input.session_id || "host-session-1",
      run_id: "run-host-codex",
      run_ids: ["run-host-codex"],
      objective: { required: false, satisfied: true, tool_calls: [{ name: "create_and_run", success: true }] },
      tool_calls: [{ id: "tool-1", name: "create_and_run", input: { yamlPath: "assets/orchestrations/test.yaml" } }],
      tool_results: [{ tool_use_id: "tool-1", content: "ok" }],
      commentary_texts: ["正在调用 Manager tools。"],
      worker_id: "host-codex",
      container_name: null,
    }));
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "HomeRail 语音测试，请创建一个一句话任务摘要，不要执行真实操作。" }),
    });
    const body = await turn.json() as {
      data: {
        spoken_text: string;
        suggested_action: string | null;
        workspace: {
          task_draft: unknown;
          pending_confirmations: unknown[];
          widgets: Array<{ id: string }>;
          conversation: Array<{ role: string; text: string; channel?: string }>;
          debug_events: Array<{ code: string }>;
          progress_brief: { status: string };
        };
        manager: { code?: string; run_ids?: string[]; text?: string };
      };
    };

    expect(turn.status).toBe(200);
    expect(body.data.spoken_text).toBe("已启动执行，我会继续跟进。");
    expect(body.data.suggested_action).toBeNull();
    expect(body.data.manager.code).toBeUndefined();
    expect(body.data.manager.run_ids).toEqual(["run-host-codex"]);
    expect(body.data.workspace.task_draft).toBeNull();
    expect(body.data.workspace.pending_confirmations).toHaveLength(0);
    expect(body.data.workspace.conversation).toContainEqual(expect.objectContaining({
      role: "assistant",
      text: "正在调用 Manager tools。",
      channel: "commentary",
    }));
    expect(body.data.workspace.progress_brief.status).toBe("done");
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-run" }));
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-agent-blocker" }));
  });

  it("routes non-Codex voice turns through the same Manager Agent container path", async () => {
    await close(server);
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-voice-project-workspace-"));
    const project = createProject({ name: "Voice Container Project", workspace_path: workspaceDir });
    const projectId = project.id;
    const observedChatBodies: Record<string, unknown>[] = [];
    const fakeNode = registerFakeDockerNode(projectId, (body) => {
      observedChatBodies.push(body);
      return {
        text: "container voice handled",
        spoken_text: "容器主 Agent 已启动执行。",
        session_id: "container-voice-session",
        run_id: "run-container-voice-123",
        run_ids: ["run-container-voice-123"],
        objective: { required: false, satisfied: true, tool_calls: [{ name: "create_and_run", success: true }] },
        tool_calls: [{ id: "tool-1", name: "create_and_run", input: { yamlPath: "assets/orchestrations/test.yaml" } }],
        tool_results: [{ tool_use_id: "tool-1", content: "ok" }],
        commentary_texts: ["正在通过容器 Manager Agent 调用工具。"],
        voice_surface: {
          progress: null,
          task_draft: null,
          widgets: [],
          remove_widget_ids: [],
        },
      };
    });
    server = createServer(0);
    upsertProvider({
      id: "qwen36",
      name: "Qwen3.6 Local",
      default_model: "qwen3.6",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
    });
    const setting = createSetting({
      provider_id: "qwen36",
      endpoint_id: "qwen36_custom",
      model_name: "qwen3.6",
      api_key: "pk-test-voice-container",
      protocol: "anthropic_compatible",
      base_url: "http://127.0.0.1:5000",
      anthropic_base_url: "http://127.0.0.1:5000",
      is_active: true,
      is_default: true,
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const saved = await fetch(`${baseUrl}/api/manager-agent/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm_setting_id: setting.id, harness: "claude_agent_sdk" }),
      });
      expect(saved.status).toBe(200);

      const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId }),
      });
      const createdBody = await created.json() as { data: { session_id: string } };
      const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "用非 Codex 主 Agent 启动一个验证任务。" }),
      });
      const body = await turn.json() as {
        data: {
          spoken_text: string;
          suggested_action: string | null;
          workspace: {
            manager_session_id?: string;
            manager_run_id?: string;
            progress_brief: { status: string };
            widgets: Array<{ id: string }>;
            conversation: Array<{ role: string; text: string; channel?: string }>;
            debug_events: Array<{ code: string }>;
          };
          manager: {
            session_id: string | null;
            run_id: string | null;
            run_ids: string[];
            objective: { satisfied?: boolean } | null;
            tool_calls: Array<{ name: string }>;
            tool_results: Array<{ tool_use_id: string }>;
          };
        };
      };

      expect(turn.status).toBe(200);
      expect(body.data.spoken_text).toBe("已启动执行，我会继续跟进。");
      expect(body.data.suggested_action).toBeNull();
      expect(body.data.manager.session_id).toBe("container-voice-session");
      expect(body.data.manager.run_id).toBe("run-container-voice-123");
      expect(body.data.manager.run_ids).toEqual(["run-container-voice-123"]);
      expect(body.data.manager.objective?.satisfied).toBe(true);
      expect(body.data.manager.tool_calls).toContainEqual(expect.objectContaining({ name: "create_and_run" }));
      expect(body.data.manager.tool_results).toContainEqual(expect.objectContaining({ tool_use_id: "tool-1" }));
      expect(body.data.workspace.manager_session_id).toBe("container-voice-session");
      expect(body.data.workspace.manager_run_id).toBe("run-container-voice-123");
      expect(body.data.workspace.progress_brief.status).toBe("done");
      expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-run" }));
      expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-agent-blocker" }));
      expect(body.data.workspace.debug_events).not.toContainEqual(expect.objectContaining({ code: "manager_agent_unavailable" }));
      expect(body.data.workspace.conversation).toContainEqual(expect.objectContaining({
        role: "assistant",
        text: "正在通过容器 Manager Agent 调用工具。",
        channel: "commentary",
      }));
      expect(observedChatBodies).toHaveLength(1);
      expect(observedChatBodies[0]).toMatchObject({
        message: "用非 Codex 主 Agent 启动一个验证任务。",
        project_id: projectId,
        continue_chat: true,
        response_mode: "voice",
        agent_config: {
          agent_type: "claude-sdk",
          provider_name: "qwen36",
          model: "qwen3.6",
          base_url: "http://127.0.0.1:5000",
        },
      });
      expect(fakeNode.requests.map((item) => `${item.resource_type}:${item.operation}`)).toEqual([
        "container:list",
        "container:create",
        "container:start",
      ]);
      const createRequest = fakeNode.requests.find((item) => item.operation === "create");
      expect(createRequest?.spec).toMatchObject({
        name: `homerail-manager-agent-${projectId}`,
        env: {
          MANAGER_AGENT_MODE: "1",
          MANAGER_AGENT_PORT: "9001",
          PROJECT_ID: projectId,
          PROJECT_WORKSPACE: "/workspace/project",
        },
        ports: [{
          hostIp: "127.0.0.1",
          hostPort: managerAgentHostPort(projectId),
          containerPort: 9001,
          protocol: "tcp",
        }],
        mount_policy: { allowed_host_roots: [workspaceDir] },
      });
      expect(createRequest?.spec.mounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ host: workspaceDir, container: "/workspace/project", mode: "rw" }),
      ]));

      const listed = await fetch(`${baseUrl}/api/voice-agent/sessions?project_id=${projectId}&limit=5`);
      const listedBody = await listed.json() as {
        data: { sessions: Array<{ session_id: string; status: string; end_time: string | null; run_ids: string[] }> };
      };
      expect(listedBody.data.sessions).toContainEqual(expect.objectContaining({
        session_id: createdBody.data.session_id,
        status: "done",
        end_time: expect.any(String),
        run_ids: ["run-container-voice-123"],
      }));
    } finally {
      await fakeNode.close();
    }
  });

  it("does not hard-code capability answers when codex_appserver is enabled", async () => {
    _setHostCodexManagerAgentRunnerForTest(async (input) => ({
      text: `真实 Manager Agent 回答：${input.message}`,
      session_id: input.session_id || "host-session-tools",
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [{ id: "finish-1", name: "finish", input: { text: "真实 Manager Agent 回答" } }],
      tool_results: [],
      worker_id: "host-codex",
      container_name: null,
    }));
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "你都会什么工具？" }),
    });
    const body = await turn.json() as { data: { spoken_text: string; workspace: { widgets: Array<{ id: string }> } } };

    expect(turn.status).toBe(200);
    expect(body.data.spoken_text).not.toBe("我能整理任务、展示状态，并在确认后交给执行流程。");
    expect(body.data.spoken_text).toContain("真实 Manager Agent 回答");
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "voice-tools" }));
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-run" }));
  });

  it("does not synthesize generated UI from verbose manager output without voice tools", async () => {
    const verbose = [
      "## Manager Agent",
      "- 启动 / 管理 HomeRail DAG 工作流：查看模板、创建运行、查询状态。",
      "- 代码与项目协作：读代码、改文件、跑测试。",
      "- 浏览器自动化：打开网页、点击、截图、检查控制台。",
      "- 联网查询：查最新资料、文档和 API 变更。",
    ].join("\n");
    _setHostCodexManagerAgentRunnerForTest(async (input) => ({
      text: verbose,
      spoken_text: verbose,
      session_id: input.session_id || "host-session-verbose",
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [{ id: "finish-1", name: "finish", input: { text: verbose } }],
      tool_results: [],
      worker_id: "host-codex",
      container_name: null,
    }));
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "你好啊，你都会干什么？" }),
    });
    const body = await turn.json() as {
      data: {
        spoken_text: string;
        workspace: {
          widgets: Array<{ id: string; type: string; body: string }>;
          conversation: Array<{ role: string; text: string; channel?: string }>;
        };
      };
    };

    expect(turn.status).toBe(200);
    expect(body.data.spoken_text.length).toBeLessThanOrEqual(80);
    expect(body.data.spoken_text).not.toBe(verbose);
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-run" }));
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-summary" }));
    expect(body.data.workspace.conversation.at(-1)).toMatchObject({
      role: "assistant",
      text: body.data.spoken_text,
      channel: "final",
    });
  });

  it("applies structured voice surface without creating the default Manager Agent status card", async () => {
    _setHostCodexManagerAgentRunnerForTest(async (input) => ({
      text: "已整理，等你确认。",
      spoken_text: "已整理，等你确认。",
      session_id: input.session_id || "host-session-surface",
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [
        { id: "draft-1", name: "update_task_draft", input: {} },
        { id: "list-1", name: "show_list_card", input: {} },
      ],
      tool_results: [],
      commentary_texts: ["正在整理任务草稿。"],
      voice_surface: {
        progress: { status: "waiting_for_confirmation", short_text: "等待确认" },
        task_draft: {
          title: "调查 AI 新闻",
          request: "调查过去二十四小时 AI 圈新闻。",
          acceptance: ["列出来源", "给出摘要"],
          constraints: ["不编造"],
          status: "needs_confirmation",
        },
        widgets: [{
          id: "news-plan",
          type: "list",
          title: "调查计划",
          body: "确认后开始查询。",
          status: "待确认",
          priority: "normal",
          items: ["新闻来源", "摘要", "链接"],
          steps: [],
          active_step: 0,
          data: {},
        }],
        remove_widget_ids: [],
      },
      worker_id: "host-codex",
      container_name: null,
    }));
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "帮我调查过去二十四小时 AI 圈新闻。" }),
    });
    const body = await turn.json() as {
      data: {
        spoken_text: string;
        voice_events: Array<{ channel: string; text: string }>;
        workspace: {
          task_draft: { title: string; status: string } | null;
          pending_confirmations: Array<{ id: string }>;
          progress_brief: { status: string; short_text: string };
          widgets: Array<{ id: string; type: string; title: string }>;
          conversation: Array<{ role: string; text: string; channel?: string }>;
        };
      };
    };

    expect(turn.status).toBe(200);
    expect(body.data.spoken_text).toBe("已整理，等你确认。");
    expect(body.data.workspace.task_draft).toMatchObject({ title: "调查 AI 新闻", status: "needs_confirmation" });
    expect(body.data.workspace.pending_confirmations).toContainEqual(expect.objectContaining({ id: "submit-task" }));
    expect(body.data.workspace.progress_brief).toMatchObject({ status: "waiting_for_confirmation", short_text: "等待确认" });
    expect(body.data.workspace.widgets).toContainEqual(expect.objectContaining({ id: "news-plan", type: "list", title: "调查计划" }));
    expect(body.data.workspace.widgets).toContainEqual(expect.objectContaining({ id: "task-draft" }));
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-run" }));
    expect(body.data.workspace.conversation).toContainEqual(expect.objectContaining({
      role: "assistant",
      text: "正在整理任务草稿。",
      channel: "commentary",
    }));
    expect(body.data.voice_events).toContainEqual(expect.objectContaining({
      channel: "commentary",
      text: "正在整理任务草稿。",
    }));
  });

  it("treats voice memo updates as generated UI rather than execution state", async () => {
    _setHostCodexManagerAgentRunnerForTest(async (input) => ({
      text: "我先记下来了，还需要确认交付形式。",
      spoken_text: "我先记下来了，还需要确认交付形式。",
      session_id: input.session_id || "host-session-memo",
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [{ id: "memo-1", name: "update_voice_memo", input: { status: "clarifying" } }],
      tool_results: [{ tool_use_id: "memo-1", content: "ok" }],
      commentary_texts: ["正在更新需求记录。"],
      voice_surface: {
        progress: null,
        task_draft: null,
        widgets: [{
          id: "voice-memo",
          type: "note",
          title: "任务记录",
          body: "用户想调查过去 24 小时 AI 新闻。",
          status: "clarifying",
          priority: "normal",
          items: ["已知 时间范围是过去 24 小时", "待确认 交付形式"],
          steps: [],
          active_step: 0,
          data: {
            ui_state: "visible",
            memo_status: "clarifying",
            ready_to_execute: false,
            memo_path: path.join(tmpHome, "manager", "voice-agent-projects", "p-memo", "assets", "memos", "host-session-memo.toml"),
          },
        }],
        remove_widget_ids: [],
      },
      effective_config: {
        harness: "host_codex",
        response_mode: "voice",
        provider: "codex",
        model: "gpt-5.5",
        reasoning_effort: input.agent_config.reasoning_effort ?? null,
        workspace: "/tmp/workspace",
        voice_ui_rules_hash: "abc123",
        voice_ui_rules_sources: ["baseline:test"],
      },
      worker_id: "host-codex",
      container_name: null,
    }));
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "p-memo" }),
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "先不要执行，帮我记下来调查 AI 新闻。" }),
    });
    const body = await turn.json() as {
      data: {
        spoken_text: string;
        manager: { effective_config?: { response_mode: string; reasoning_effort: string | null } };
        workspace: {
          widgets: Array<{ id: string; type: string; title: string }>;
          conversation: Array<{ role: string; text: string; channel?: string }>;
          progress_brief: { status: string };
        };
      };
    };

    expect(turn.status).toBe(200);
    expect(body.data.spoken_text).toBe("我先记下来了，还需要确认交付形式。");
    expect(body.data.workspace.progress_brief.status).toBe("done");
    expect(body.data.workspace.widgets).toContainEqual(expect.objectContaining({ id: "voice-memo", type: "note", title: "任务记录" }));
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-run" }));
    expect(body.data.workspace.conversation).toContainEqual(expect.objectContaining({
      role: "assistant",
      text: "正在更新需求记录。",
      channel: "commentary",
    }));
    expect(body.data.manager.effective_config).toMatchObject({ response_mode: "voice", reasoning_effort: "low" });
  });

  it("does not route manager keywords to a hard-coded status response", async () => {
    _setHostCodexManagerAgentRunnerForTest(async (input) => ({
      text: `我会按你的请求处理：${input.message}`,
      session_id: input.session_id || "host-session-keywords",
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [],
      tool_results: [],
      worker_id: "host-codex",
      container_name: null,
    }));
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "我需要由你，而不是manager agent去调查一下，现在。过去二十四小时的AI圈新闻。" }),
    });
    const body = await turn.json() as {
      data: {
        spoken_text: string;
        workspace: { debug_events: Array<{ code: string }>; widgets: Array<{ id: string }> };
        voice_events: Array<{ channel: string; text: string }>;
      };
    };

    expect(turn.status).toBe(200);
    expect(body.data.spoken_text).not.toBe("当前没有运行中的任务。");
    expect(body.data.spoken_text).toContain("我会按你的请求处理");
    expect(body.data.workspace.debug_events).not.toContainEqual(expect.objectContaining({ code: "manager_agent_unavailable" }));
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-status" }));
  });

  it("does not synthesize task drafts from voice text before routing to Manager Agent", async () => {
    _setHostCodexManagerAgentRunnerForTest(async () => ({
      text: "真实 Manager Agent 已收到确认请求。",
      session_id: "host-session-no-draft",
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [],
      tool_results: [],
      worker_id: "host-codex",
      container_name: null,
    }));
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "确认，开始执行这个 DAG review。" }),
    });
    const body = await turn.json() as {
      data: {
        spoken_text: string;
        suggested_action: string | null;
        workspace: {
          task_draft: unknown;
          progress_brief: { status: string };
          pending_confirmations: unknown[];
          debug_events: Array<{ code: string }>;
          widgets: Array<{ id: string; status?: string }>;
        };
      };
    };

    expect(turn.status).toBe(200);
    expect(body.data.suggested_action).toBeNull();
    expect(body.data.spoken_text).toBe("真实 Manager Agent 已收到确认请求。");
    expect(body.data.workspace.task_draft).toBeNull();
    expect(body.data.workspace.pending_confirmations).toHaveLength(0);
    expect(body.data.workspace.progress_brief.status).toBe("done");
    expect(body.data.workspace.debug_events).not.toContainEqual(expect.objectContaining({ code: "manager_agent_unavailable" }));
    expect(body.data.workspace.widgets).not.toContainEqual(expect.objectContaining({ id: "manager-agent-blocker" }));
  });

  it("submits confirmations to Manager Agent instead of only marking submitted", async () => {
    _setHostCodexManagerAgentRunnerForTest(async (input) => ({
      text: `确认已交给 host Codex：${input.message}`,
      session_id: input.session_id || "host-session-confirm",
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [],
      tool_results: [],
      worker_id: "host-codex",
      container_name: null,
    }));
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness: "codex_appserver", model_name: "gpt-5.5", reasoning_effort: "low" }),
    });
    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json() as { data: { session_id: string } };
    await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "帮我修复 Codex 执行路径" }),
    });

    const confirm = await fetch(`${baseUrl}/api/voice-agent/sessions/${createdBody.data.session_id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation_id: "submit-task" }),
    });
    const body = await confirm.json() as {
      data: {
        spoken_text: string;
        manager: { code?: string; error?: string; text?: string };
        workspace: {
          progress_brief: { status: string };
          debug_events: Array<{ code: string }>;
        };
      };
    };

    expect(confirm.status).toBe(200);
    expect(body.data.spoken_text).toContain("确认已交给 host Codex");
    expect(body.data.manager.code).toBeUndefined();
    expect(body.data.manager.text).not.toBe("当前 TS Manager 已记录确认；真实执行请通过 DAG 或后续 harness 接入。");
    expect(body.data.workspace.progress_brief.status).toBe("done");
    expect(body.data.workspace.debug_events).not.toContainEqual(expect.objectContaining({ code: "manager_agent_unavailable" }));
  });

  // ── P1 回归：同 session 并发 turn 不能丢消息 ──────────────────────────
  // 之前 loadWorkspace 在 withSessionLock 外执行，第二个并发 turn 拿旧快照
  // 覆盖 DB，导致第一轮的 conversation 丢失。修复后两轮都应保留。
  it("preserves conversation from both turns when the same session receives concurrent /turn requests", async () => {
    // Runner 有延迟，让两个 turn 真正并发排队。
    _setHostCodexManagerAgentRunnerForTest(async (input) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      return {
        text: `answer to: ${input.message}`,
        spoken_text: `已处理 ${input.message}。`,
        session_id: input.session_id || "host-session-concurrent",
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: [],
        tool_results: [],
        worker_id: "host-codex",
        container_name: null,
      };
    });
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: null }),
    });
    const createdBody = await created.json();
    const sessionId = createdBody.data.session_id;

    // 同时发两个 turn（并发），验证 mutex 串行化 + 不丢消息。
    const [t1, t2] = await Promise.all([
      fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "first" }),
      }),
      fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "second" }),
      }),
    ]);

    expect(t1.status).toBe(200);
    expect(t2.status).toBe(200);

    // 读取最终 workspace，验证两轮 user 消息都在 conversation 里。
    const ws = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}`);
    const wsBody = await ws.json();
    const conversation = wsBody.data.conversation as Array<{ role: string; text: string }>;
    const userTexts = conversation.filter((m) => m.role === "user").map((m) => m.text);

    expect(userTexts).toContain("first");
    expect(userTexts).toContain("second");
  });

  // ── P1 回归：interrupted 状态必须能被 saveWorkspace 接受 ──────────────
  it("accepts interrupted status without throwing on subsequent saveWorkspace", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const created = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: null }),
    });
    const createdBody = await created.json();
    const sessionId = createdBody.data.session_id;

    // 模拟 stale recovery 把 status 写成 interrupted。
    const db = getDb();
    const row = db.prepare("SELECT data FROM voice_agent_sessions WHERE session_id = ?").get(sessionId) as { data: string };
    const workspace = JSON.parse(row.data);
    workspace.progress_brief = { status: "interrupted", updated_at: new Date().toISOString() };
    db.prepare("UPDATE voice_agent_sessions SET data = ? WHERE session_id = ?").run(JSON.stringify(workspace), sessionId);

    // 之后任何路径调 saveWorkspace 都不应抛 "Invalid session status: interrupted"。
    // notifications 端点内部会 saveWorkspace，用它验证。
    const notify = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: "normal", title: "测试通知", body: "test" }),
    });
    expect(notify.status).toBe(200);
  });
});

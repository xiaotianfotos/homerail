import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GENERATIVE_UI_MODE_ENV } from "../src/generative-ui/mode.js";
import { closeDb, getDb } from "../src/persistence/db.js";
import {
  _setHostCodexManagerAgentRunnerForTest,
  _setHostCodexManagerAgentStreamRunnerForTest,
} from "../src/server/host-codex-manager-agent.js";
import { createServer } from "../src/server/http.js";
import {
  _clearStoredConfig,
  _getGenerativeUiShadowForTest,
} from "../src/server/voice-agent-bootstrap.js";
import type { CodexModelCatalog } from "../src/server/codex-models.js";
import { executeHomerailPluginTool } from "homerail-protocol";
import { assemblePluginTurnContext } from "../src/plugins/context-assembler.js";

const catalog: CodexModelCatalog = {
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

interface ShadowState {
  snapshot: null | {
    status: "ok" | "error";
    legacy_widget_count: number;
    document_revision: number;
    transaction_status: string;
    matched: boolean;
  };
  document: null | {
    revision: number;
    nodes: Array<{ id: string; kind: string; revision: number }>;
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function configure(baseUrl: string, mode: "off" | "shadow" | "prefer"): Promise<void> {
  const response = await fetch(`${baseUrl}/api/voice-agent/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      harness: "codex_appserver",
      model_name: "gpt-5.5",
      reasoning_effort: "low",
      generative_ui_mode: mode,
    }),
  });
  expect(response.status).toBe(200);
}

async function createSession(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.json() as { data: { session_id: string } };
  expect(response.status).toBe(201);
  return body.data.session_id;
}

function resultWithWidget(input: { session_id?: string }, data: Record<string, unknown> = {}) {
  return {
    text: "Legacy Widget updated.",
    spoken_text: "已更新。",
    session_id: input.session_id || "host-shadow-session",
    run_id: null,
    run_ids: [],
    objective: { required: false, satisfied: true, tool_calls: [] },
    tool_calls: [],
    tool_results: [],
    commentary_texts: [],
    voice_surface: {
      progress: null,
      task_draft: null,
      widgets: [{
        id: "shadow-note",
        type: "note",
        title: "Legacy remains authoritative",
        body: "Shadow consumes this result without invoking another Tool.",
        priority: "normal",
        status: "ready",
        items: [],
        steps: [],
        data,
      }],
      remove_widget_ids: [],
    },
    worker_id: "host-codex",
    container_name: null,
  };
}

function resultWithLegacyTopic(input: { session_id?: string }, id: string) {
  const result = resultWithWidget(input);
  result.voice_surface.widgets = [{
    id,
    type: "topic_outline",
    title: "Legacy topic compatibility",
    body: "The effective off mode keeps the legacy scene writable.",
    priority: "normal",
    status: "ready",
    items: [],
    steps: [],
    data: { visual: "topic_outline", thesis: "The kill switch is exact." },
  }];
  return result;
}

describe("Voice Generative UI shadow runtime", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpHome: string;
  let previousHome: string | undefined;
  let previousAutostart: string | undefined;
  let previousMode: string | undefined;

  beforeEach(async () => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    previousAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    previousMode = process.env[GENERATIVE_UI_MODE_ENV];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-shadow-runtime-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    delete process.env[GENERATIVE_UI_MODE_ENV];
    _clearStoredConfig();
    server = createServer(0, undefined, undefined, false, {
      loadCodexModels: async () => catalog,
      autoDetectCodex: true,
    });
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    _setHostCodexManagerAgentRunnerForTest();
    _setHostCodexManagerAgentStreamRunnerForTest();
    if (server.listening) await close(server);
    _clearStoredConfig();
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = previousAutostart;
    if (previousMode === undefined) delete process.env[GENERATIVE_UI_MODE_ENV];
    else process.env[GENERATIVE_UI_MODE_ENV] = previousMode;
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("dual-writes one matched shadow document without duplicating the Agent call", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    const runner = vi.fn(async (input: { session_id?: string }) => resultWithWidget(input));
    _setHostCodexManagerAgentRunnerForTest(runner);

    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Show the legacy note." }),
    });
    const body = await turn.json() as {
      data: { workspace: { widgets: Array<{ id: string }>; debug_events: Array<{ code: string }> } };
    };

    expect(turn.status).toBe(200);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(body.data.workspace.widgets.map((item) => item.id)).toEqual(["shadow-note"]);
    expect(body.data.workspace.debug_events).toContainEqual(expect.objectContaining({
      code: "generative_ui_shadow_matched",
    }));
    expect(_getGenerativeUiShadowForTest(sessionId) as ShadowState).toMatchObject({
      snapshot: { transaction_status: "applied", matched: true, document_revision: 1 },
      document: {
        revision: 1,
        nodes: [{ id: "shadow-note", kind: "com.homerail.core/notice", revision: 1 }],
      },
    });

    const projection = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`);
    const projectionBody = await projection.json() as {
      data: { authoritative: boolean; cursor: number; document: { document_id: string; revision: number } };
    };
    expect(projection.status).toBe(200);
    expect(projectionBody.data).toMatchObject({
      authoritative: false,
      cursor: 1,
      document: { revision: 1 },
    });
    const etag = projection.headers.get("etag");
    expect(etag).toBeTruthy();
    expect((await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`, {
      headers: { "If-None-Match": etag! },
    })).status).toBe(304);
    expect((await fetch(`${baseUrl}/api/plugins/com.homerail.topic-outline/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, expected_revision: 1, expected_active_version: "1.0.0" }),
    })).status).toBe(200);
    const registryChanged = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`, {
      headers: { "If-None-Match": etag! },
    });
    const registryChangedEtag = registryChanged.headers.get("etag")!;
    const registryChangedBody = await registryChanged.json() as {
      data: {
        document: { revision: number };
        ui_registry: { renderers: Array<{ renderer_id: string; enabled: boolean }> };
      };
    };
    expect(registryChanged.status).toBe(200);
    expect(registryChangedEtag).not.toBe(etag);
    expect(registryChangedBody.data.document.revision).toBe(1);
    expect(registryChangedBody.data.ui_registry.renderers).toContainEqual(expect.objectContaining({
      renderer_id: "topic-outline-main",
      enabled: false,
    }));
    expect((await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`, {
      headers: { "If-None-Match": registryChangedEtag },
    })).status).toBe(304);

    const ledger = await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui/transactions?after_seq=0&limit=1`,
    );
    const ledgerBody = await ledger.json() as {
      data: { transactions: Array<{ seq: number; committed_revision: number }>; has_more: boolean };
    };
    expect(ledgerBody.data).toMatchObject({
      transactions: [{ seq: 1, committed_revision: 1 }],
      has_more: false,
    });
    const replay = await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui/stream?after_seq=0&limit=1`,
    );
    const replayLines = (await replay.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(replayLines.map((line) => line.event)).toEqual(["snapshot", "transaction"]);

    await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/manager-status`, { method: "POST" });
    const afterNoop = _getGenerativeUiShadowForTest(sessionId) as ShadowState;
    expect(afterNoop).toMatchObject({
      snapshot: { transaction_status: "noop", document_revision: 1, matched: true },
      document: { revision: 1 },
    });
    expect(runner).toHaveBeenCalledTimes(1);

    closeDb();
    const recovered = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`);
    expect(recovered.status).toBe(200);
    expect((await recovered.json()) as unknown).toMatchObject({
      data: { cursor: 1, document: { revision: 1 } },
    });
  });

  it("persists scope-bound user overrides and recomposes without mutating the document", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    _setHostCodexManagerAgentRunnerForTest(async (input) => resultWithWidget(input));
    expect((await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Create one overridable note." }),
    })).status).toBe(200);

    const before = await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui?device=phone&input=touch&viewport=compact`,
    );
    const beforeBody = await before.json() as {
      data: {
        document: { revision: number; nodes: Array<Record<string, unknown>> };
        overrides: unknown[];
        composition: { context: { device: string }; items: Array<{ node_id: string }>; hidden_node_ids: string[] };
      };
    };
    expect(beforeBody.data).toMatchObject({
      document: { revision: 1 },
      overrides: [],
      composition: {
        context: { device: "phone" },
        items: [{ node_id: "shadow-note" }],
        hidden_node_ids: [],
      },
    });
    const beforeEtag = before.headers.get("etag");
    expect(beforeEtag).toBeTruthy();

    const saved = await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui/overrides/shadow-note`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "hidden", pinned: true }),
      },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      data: { override: { node_id: "shadow-note", visibility: "hidden", pinned: true } },
    });

    const recomposed = await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui?device=phone&input=touch&viewport=compact`,
      { headers: { "If-None-Match": beforeEtag! } },
    );
    const recomposedBody = await recomposed.json() as {
      data: {
        document: { revision: number; nodes: Array<Record<string, unknown>> };
        overrides: Array<{ node_id: string; visibility: string }>;
        composition: { items: unknown[]; hidden_node_ids: string[] };
      };
    };
    expect(recomposed.status).toBe(200);
    expect(recomposed.headers.get("etag")).not.toBe(beforeEtag);
    expect(recomposedBody.data).toMatchObject({
      document: { revision: 1 },
      overrides: [{ node_id: "shadow-note", visibility: "hidden" }],
      composition: { items: [], hidden_node_ids: ["shadow-note"] },
    });
    expect(recomposedBody.data.document.nodes[0]).not.toHaveProperty("pinned");
    expect(recomposedBody.data.document.nodes[0]).not.toHaveProperty("visibility");

    closeDb();
    const recovered = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`);
    expect((await recovered.json()) as unknown).toMatchObject({
      data: {
        overrides: [{ node_id: "shadow-note", visibility: "hidden" }],
        composition: { hidden_node_ids: ["shadow-note"] },
      },
    });
    expect((await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui?device=watch`)).status)
      .toBe(400);
    expect((await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui/overrides/shadow-note`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ css: "position: fixed" }),
      },
    )).status).toBe(400);

    expect((await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui/overrides/shadow-note`,
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}`, { method: "DELETE" })).status)
      .toBe(200);
    expect((await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui/overrides/shadow-note`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: true }),
      },
    )).status).toBe(409);
  });

  it("accepts a plugin execution side channel and keeps its semantic history through disable", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    const descriptor = assemblePluginTurnContext(undefined, { modality: "voice" }).tools.find((tool) => (
      tool.plugin_id === "com.homerail.topic-outline"
    ))!;
    const envelope = executeHomerailPluginTool(descriptor, {
      id: "com.homerail.topic-outline:topic-runtime",
      title: "Plugin production pipeline",
      brief: "Move from Skill through Tool execution to a semantic Renderer.",
      thesis: "Plugins are the scenario delivery unit.",
      outline: [{ title: "Vertical slice", status: "ready", points: ["Manifest", "Context", "Renderer"] }],
      questions: ["How does disabled history render?"],
      sources: [{ title: "M3 plan", url: "https://example.com/m3-plan", note: "Local architecture baseline" }],
      next_action: "Disable the plugin",
    });
    _setHostCodexManagerAgentRunnerForTest(async (input) => ({
      text: "Topic outline projected.",
      spoken_text: "大纲已更新。",
      session_id: input.session_id || "host-plugin-runtime",
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [],
      tool_results: [],
      commentary_texts: [],
      voice_surface: {
        progress: null,
        task_draft: null,
        widgets: [envelope.projection.legacy_widget!],
        remove_widget_ids: [],
        plugin_projections: [envelope],
      },
      worker_id: "host-codex",
      container_name: null,
    }));
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Create the plugin outline." }),
    });
    expect(turn.status).toBe(200);
    const enabledProjection = await (await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`,
    )).json() as {
      data: {
        document: { revision: number; nodes: Array<Record<string, unknown>> };
        ui_registry: { renderers: Array<Record<string, unknown>> };
      };
    };
    expect(enabledProjection.data.document.nodes).toContainEqual(expect.objectContaining({
      id: "com.homerail.topic-outline:topic-runtime",
      kind: "com.homerail.topic-outline/outline",
      content: expect.objectContaining({ title: "Plugin production pipeline" }),
      fallback: expect.objectContaining({
        items: expect.arrayContaining([
          "Thesis: Plugins are the scenario delivery unit.",
          "Section: Vertical slice: Manifest; Context; Renderer",
        ]),
      }),
    }));
    expect(enabledProjection.data.ui_registry.renderers).toContainEqual(expect.objectContaining({
      renderer_id: "topic-outline-main",
      enabled: true,
    }));

    expect((await fetch(`${baseUrl}/api/plugins/com.homerail.topic-outline/enabled`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, expected_revision: 1, expected_active_version: "1.0.0" }),
    })).status).toBe(200);
    const disabledProjection = await (await fetch(
      `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`,
    )).json() as typeof enabledProjection;
    expect(disabledProjection.data.document).toMatchObject({ revision: 1 });
    expect(disabledProjection.data.document.nodes).toContainEqual(expect.objectContaining({
      id: "com.homerail.topic-outline:topic-runtime",
      kind: "com.homerail.topic-outline/outline",
    }));
    expect(disabledProjection.data.ui_registry.renderers).toContainEqual(expect.objectContaining({
      renderer_id: "topic-outline-main",
      enabled: false,
    }));
  });

  it("publishes prefer plugin nodes canonically while retaining legacy core UI and honoring off", async () => {
    await configure(baseUrl, "prefer");
    const sessionId = await createSession(baseUrl);
    const descriptor = assemblePluginTurnContext(undefined, { modality: "voice" }).tools.find((tool) => (
      tool.plugin_id === "com.homerail.topic-outline"
    ))!;
    const envelope = executeHomerailPluginTool(descriptor, {
      id: "com.homerail.topic-outline:prefer-runtime",
      title: "Prefer canonical plugin node",
      thesis: "Legacy core UI remains alongside it.",
    });
    _setHostCodexManagerAgentRunnerForTest(async (input) => ({
      text: "Prefer projection created.",
      spoken_text: "已创建。",
      session_id: input.session_id || sessionId,
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [],
      tool_results: [],
      commentary_texts: [],
      voice_surface: {
        progress: { status: "running", short_text: "Core progress remains visible" },
        task_draft: {
          title: "Core task draft",
          request: "Keep core UI",
          status: "draft",
        },
        widgets: [{
          id: "core-note",
          type: "note",
          title: "Core legacy note",
          body: "Retained fallback content",
          priority: "normal",
          status: "ready",
          items: [],
          steps: [],
          data: {},
        }, envelope.projection.legacy_widget!],
        remove_widget_ids: [],
        plugin_projections: [envelope],
      },
      worker_id: "host-codex",
      container_name: null,
    }));

    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Create the plugin outline." }),
    });
    const body = await turn.json() as {
      data: {
        workspace: {
          task_draft: { title: string };
          progress_brief: { short_text: string };
          widgets: Array<{ id: string }>;
          plugin_nodes: Array<{ id: string }>;
          generative_ui_canonical_pending?: unknown;
          debug_events: Array<{ code: string; message: string }>;
        };
      };
    };
    expect(body.data.workspace).toMatchObject({
      task_draft: { title: "Core task draft" },
      progress_brief: { short_text: "Core progress remains visible" },
      widgets: expect.arrayContaining([
        expect.objectContaining({ id: "core-note" }),
        expect.objectContaining({ id: "com.homerail.topic-outline:prefer-runtime" }),
      ]),
      plugin_nodes: [{ id: "com.homerail.topic-outline:prefer-runtime" }],
    });
    expect(body.data.workspace).not.toHaveProperty("generative_ui_canonical_pending");
    expect(_getGenerativeUiShadowForTest(sessionId)).toMatchObject({ snapshot: null, document: null });

    const projectionUrl = `${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`;
    const projection = await fetch(projectionUrl);
    expect(await projection.json()).toMatchObject({
      data: {
        mode: "prefer",
        authoritative: true,
        purpose: "canonical",
        document: {
          revision: 1,
          nodes: [{
            id: "com.homerail.topic-outline:prefer-runtime",
            content: { title: "Prefer canonical plugin node" },
          }],
        },
      },
    });

    process.env[GENERATIVE_UI_MODE_ENV] = "off";
    expect((await fetch(projectionUrl)).status).toBe(404);
    const retained = await (await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}`)).json();
    expect(retained).toMatchObject({
      data: {
        task_draft: { title: "Core task draft" },
        widgets: expect.arrayContaining([expect.objectContaining({ id: "core-note" })]),
      },
    });
  });

  it("commits the legacy bridge only with an accepted projection and protects an existing semantic id", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    const descriptor = assemblePluginTurnContext(undefined, { modality: "voice" }).tools.find((tool) => (
      tool.plugin_id === "com.homerail.topic-outline"
    ))!;
    const envelope = executeHomerailPluginTool(descriptor, {
      id: "com.homerail.topic-outline:topic-atomic",
      title: "Atomic plugin projection",
      thesis: "The broker owns both writes.",
    });
    const resultFor = (pluginEnvelope: unknown, widgets: unknown[]) => ({
      text: "Topic outline projected.",
      spoken_text: "大纲已更新。",
      session_id: sessionId,
      run_id: null,
      run_ids: [],
      objective: { required: false, satisfied: true, tool_calls: [] },
      tool_calls: [],
      tool_results: [],
      commentary_texts: [],
      voice_surface: {
        progress: null,
        task_draft: null,
        widgets,
        remove_widget_ids: [],
        plugin_projections: [pluginEnvelope],
      },
      worker_id: "host-codex",
      container_name: null,
    });

    const tampered = structuredClone(envelope);
    tampered.projection.node.content.title = "Tampered projection";
    _setHostCodexManagerAgentRunnerForTest(async () => resultFor(
      tampered,
      [envelope.projection.legacy_widget!],
    ));
    const rejected = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Reject this projection." }),
    });
    const rejectedBody = await rejected.json() as {
      data: { workspace: { widgets: Array<{ id: string }>; plugin_nodes: Array<{ id: string }>; debug_events: Array<{ code: string }> } };
    };
    expect(rejected.status).toBe(200);
    expect(rejectedBody.data.workspace.widgets.some((widget) => widget.id === "com.homerail.topic-outline:topic-atomic")).toBe(false);
    expect(rejectedBody.data.workspace.plugin_nodes).toEqual([]);
    expect(rejectedBody.data.workspace.debug_events).toContainEqual(expect.objectContaining({
      code: "plugin_projection_rejected",
    }));

    _setHostCodexManagerAgentRunnerForTest(async () => resultFor(envelope, []));
    expect((await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Create a topic outline with the original projection." }),
    })).status).toBe(200);

    _setHostCodexManagerAgentRunnerForTest(async () => ({
      ...resultFor(envelope, []),
      voice_surface: {
        progress: null,
        task_draft: null,
        widgets: [{
          id: "com.homerail.topic-outline:topic-atomic",
          type: "note",
          title: "Unbrokered replacement",
          data: {},
        }, {
          id: "topic-bypass-new",
          type: "html",
          title: "Unbrokered new topic",
          data: { visual: "topic_outline" },
        }],
        remove_widget_ids: [],
        plugin_projections: [],
      },
    }));
    const conflict = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Try an unbrokered replacement." }),
    });
    const conflictBody = await conflict.json() as {
      data: {
        workspace: {
          widgets: Array<{ id: string; title: string }>;
          plugin_nodes: Array<{ id: string; content: { title: string } }>;
          debug_events: Array<{ code: string }>;
        };
      };
    };
    expect(conflictBody.data.workspace.widgets).toContainEqual(expect.objectContaining({
      id: "com.homerail.topic-outline:topic-atomic",
      title: "Atomic plugin projection",
    }));
    expect(conflictBody.data.workspace.widgets.some((widget) => widget.id === "topic-bypass-new")).toBe(false);
    expect(conflictBody.data.workspace.plugin_nodes).toContainEqual(expect.objectContaining({
      id: "com.homerail.topic-outline:topic-atomic",
      content: { title: "Atomic plugin projection", thesis: "The broker owns both writes." },
    }));
    expect(conflictBody.data.workspace.debug_events).toContainEqual(expect.objectContaining({
      code: "plugin_widget_conflict_rejected",
    }));
    expect(conflictBody.data.workspace.debug_events).toContainEqual(expect.objectContaining({
      code: "plugin_widget_bypass_rejected",
    }));
  });

  it("rejects an in-flight plugin projection when the global mode switches off before commit", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    const descriptor = assemblePluginTurnContext(undefined, { modality: "voice" }).tools.find((tool) => (
      tool.plugin_id === "com.homerail.topic-outline"
    ))!;
    const envelope = executeHomerailPluginTool(descriptor, {
      id: "com.homerail.topic-outline:mode-race",
      title: "Must not commit after emergency off",
    });
    _setHostCodexManagerAgentRunnerForTest(async (input) => {
      await configure(baseUrl, "off");
      return {
        text: "Projection completed after the mode changed.",
        spoken_text: "模式已经关闭。",
        session_id: input.session_id || sessionId,
        run_id: null,
        run_ids: [],
        objective: { required: false, satisfied: true, tool_calls: [] },
        tool_calls: [],
        tool_results: [],
        commentary_texts: [],
        voice_surface: {
          progress: null,
          task_draft: null,
          widgets: [],
          remove_widget_ids: [],
          plugin_projections: [envelope],
        },
        worker_id: "host-codex",
        container_name: null,
      };
    });
    const response = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Start while shadow is enabled." }),
    });
    const body = await response.json() as {
      data: {
        workspace: {
          widgets: Array<{ id: string }>;
          plugin_nodes: Array<{ id: string }>;
          debug_events: Array<{ code: string }>;
        };
      };
    };
    expect(response.status).toBe(200);
    expect(body.data.workspace.widgets).toEqual([]);
    expect(body.data.workspace.plugin_nodes).toEqual([]);
    expect(body.data.workspace.debug_events).toContainEqual(expect.objectContaining({
      code: "plugin_projection_mode_rejected",
    }));
  });

  it("keeps the exact legacy path when the session snapshot is off", async () => {
    await configure(baseUrl, "off");
    const sessionId = await createSession(baseUrl);
    const runner = vi.fn(async (input: { session_id?: string }) => {
      const result = resultWithWidget(input);
      result.voice_surface.widgets = [{
        id: "legacy-topic-off",
        type: "topic_outline",
        title: "Legacy topic remains authoritative while off",
        body: "Compatibility mode does not apply plugin write reservations.",
        priority: "normal",
        status: "ready",
        items: [],
        steps: [],
        data: { visual: "topic_outline", thesis: "Preserve the off path." },
      }];
      return result;
    });
    _setHostCodexManagerAgentRunnerForTest(runner);

    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Stay on the legacy path." }),
    });
    const body = await turn.json() as {
      data: { workspace: { widgets: Array<{ id: string }>; debug_events: Array<{ code: string }> } };
    };

    expect(turn.status).toBe(200);
    expect(body.data.workspace.widgets.map((item) => item.id)).toEqual(["legacy-topic-off"]);
    expect(body.data.workspace.debug_events.some((event) => event.code.startsWith("generative_ui_shadow"))).toBe(false);
    expect(_getGenerativeUiShadowForTest(sessionId)).toEqual({ snapshot: null, document: null });
    expect((await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`)).status).toBe(404);
  });

  it("honors global off as a reversible emergency kill switch", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    const runner = vi.fn(async (input: { session_id?: string }) => resultWithLegacyTopic(input, "global-off-topic"));
    _setHostCodexManagerAgentRunnerForTest(runner);

    process.env[GENERATIVE_UI_MODE_ENV] = "off";
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Temporarily disable shadow." }),
    });
    const turnBody = await turn.json() as { data: { workspace: { widgets: Array<{ id: string }> } } };
    expect(turn.status).toBe(200);
    expect(turnBody.data.workspace.widgets.map((widget) => widget.id)).toEqual(["global-off-topic"]);
    expect(_getGenerativeUiShadowForTest(sessionId)).toEqual({ snapshot: null, document: null });

    delete process.env[GENERATIVE_UI_MODE_ENV];
    const resumed = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/manager-status`, { method: "POST" });
    expect(resumed.status).toBe(200);
    expect(_getGenerativeUiShadowForTest(sessionId) as ShadowState).toMatchObject({
      snapshot: { legacy_widget_count: 1, transaction_status: "applied", document_revision: 1, matched: true },
      document: { revision: 1, nodes: [{ id: "global-off-topic", kind: "com.homerail.content/topic_outline" }] },
    });
  });

  it("honors persisted off for an existing shadow session when no environment override exists", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    await configure(baseUrl, "off");
    _setHostCodexManagerAgentRunnerForTest(async (input) => resultWithLegacyTopic(input, "persisted-off-topic"));

    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Disable through persisted config." }),
    });

    const turnBody = await turn.json() as { data: { workspace: { widgets: Array<{ id: string }> } } };
    expect(turn.status).toBe(200);
    expect(turnBody.data.workspace.widgets.map((widget) => widget.id)).toEqual(["persisted-off-topic"]);
    expect(_getGenerativeUiShadowForTest(sessionId)).toEqual({ snapshot: null, document: null });
  });

  it("does not shadow-write when the authoritative SQLite commit fails", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    const runner = vi.fn(async (input: { session_id?: string }) => resultWithWidget(input));
    _setHostCodexManagerAgentRunnerForTest(runner);
    getDb().exec(`
      CREATE TRIGGER fail_shadow_runtime_legacy_save
      BEFORE UPDATE ON voice_agent_sessions
      BEGIN
        SELECT RAISE(FAIL, 'forced legacy save failure');
      END;
    `);

    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "The legacy commit must happen first." }),
    });

    expect(turn.status).toBe(400);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(_getGenerativeUiShadowForTest(sessionId)).toEqual({ snapshot: null, document: null });
    getDb().exec("DROP TRIGGER fail_shadow_runtime_legacy_save");

    const loaded = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}`);
    const loadedBody = await loaded.json() as { data: { widgets: unknown[] } };
    expect(loadedBody.data.widgets).toEqual([]);
  });

  it("keeps pre-M1 workspaces off even when the global mode is shadow", async () => {
    await configure(baseUrl, "shadow");
    const fixture = JSON.parse(fs.readFileSync(
      new URL("./fixtures/voice/legacy-voice-workspace-v1.json", import.meta.url),
      "utf8",
    )) as { session_id: string; project_id: string; updated_at: string };
    getDb().prepare(`
      INSERT INTO voice_agent_sessions(session_id, project_id, updated_at, data)
      VALUES (?, ?, ?, ?)
    `).run(fixture.session_id, fixture.project_id, fixture.updated_at, JSON.stringify(fixture));

    const refreshed = await fetch(
      `${baseUrl}/api/voice-agent/sessions/${fixture.session_id}/manager-status`,
      { method: "POST" },
    );

    expect(refreshed.status).toBe(200);
    expect(_getGenerativeUiShadowForTest(fixture.session_id)).toEqual({ snapshot: null, document: null });
  });

  it("releases in-memory shadow state when a session is explicitly closed", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    _setHostCodexManagerAgentRunnerForTest(async (input) => resultWithWidget(input));
    await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Create shadow state." }),
    });
    expect((_getGenerativeUiShadowForTest(sessionId) as ShadowState).document?.revision).toBe(1);

    const closed = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}`, { method: "DELETE" });
    expect(closed.status).toBe(200);
    expect(_getGenerativeUiShadowForTest(sessionId)).toEqual({ snapshot: null, document: null });

    const refreshed = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/manager-status`, {
      method: "POST",
    });
    expect(refreshed.status).toBe(200);
    expect(_getGenerativeUiShadowForTest(sessionId)).toEqual({ snapshot: null, document: null });

    const reopened = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Reactivate this closed session." }),
    });
    expect(reopened.status).toBe(200);
    expect(_getGenerativeUiShadowForTest(sessionId)).toMatchObject({
      snapshot: { status: "ok", document_revision: 1, matched: true },
      document: { revision: 1, nodes: [{ id: "shadow-note" }] },
    });

    expect((await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}`, { method: "DELETE" })).status).toBe(200);
    expect(_getGenerativeUiShadowForTest(sessionId)).toEqual({ snapshot: null, document: null });
    const streamed = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Reactivate this session through streaming." }),
    });
    expect(streamed.status).toBe(200);
    const streamLines = (await streamed.text()).trim().split("\n").map((line) => JSON.parse(line) as {
      type: string;
      event?: string;
      authoritative?: boolean;
      committed_revision?: number;
    });
    const streamTypes = streamLines.map((line) => line.type);
    const generativeUiIndex = streamLines.findIndex((line) => (
      line.type === "generative_ui" && line.event === "transaction"
    ));
    expect(streamLines.filter((line) => line.type === "generative_ui")).toHaveLength(1);
    expect(streamLines[generativeUiIndex]).toMatchObject({
      event: "transaction",
      authoritative: false,
      committed_revision: 1,
    });
    expect(generativeUiIndex).toBeGreaterThanOrEqual(0);
    expect(generativeUiIndex).toBeLessThan(streamTypes.lastIndexOf("workspace"));
    expect(generativeUiIndex).toBeLessThan(streamTypes.indexOf("done"));
    expect(_getGenerativeUiShadowForTest(sessionId)).toMatchObject({
      snapshot: { status: "ok", document_revision: 1, matched: true },
      document: { revision: 1, nodes: [{ id: "shadow-note" }] },
    });
  });

  it("retries a shadow diagnostic that failed its best-effort persistence", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    _setHostCodexManagerAgentRunnerForTest(async (input) => resultWithWidget(input));
    getDb().exec(`
      CREATE TRIGGER fail_shadow_debug_persist
      BEFORE UPDATE ON voice_agent_sessions
      WHEN NEW.data LIKE '%generative_ui_shadow_%'
      BEGIN
        SELECT RAISE(ABORT, 'forced shadow diagnostic persistence failure');
      END
    `);

    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Create one recoverable shadow diagnostic." }),
    });
    const turnBody = await turn.json() as {
      data: { workspace: { debug_events: Array<{ code: string }> } };
    };
    expect(turn.status).toBe(200);
    expect(turnBody.data.workspace.debug_events).toContainEqual(expect.objectContaining({
      code: "generative_ui_shadow_matched",
    }));

    const storedBefore = getDb().prepare(
      "SELECT data FROM voice_agent_sessions WHERE session_id = ?",
    ).get(sessionId) as { data: string };
    expect((JSON.parse(storedBefore.data) as { debug_events: Array<{ code: string }> }).debug_events)
      .not.toContainEqual(expect.objectContaining({ code: "generative_ui_shadow_matched" }));
    getDb().exec("DROP TRIGGER fail_shadow_debug_persist");

    const retried = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/manager-status`, {
      method: "POST",
    });
    expect(retried.status).toBe(200);
    const storedAfter = getDb().prepare(
      "SELECT data FROM voice_agent_sessions WHERE session_id = ?",
    ).get(sessionId) as { data: string };
    expect((JSON.parse(storedAfter.data) as { debug_events: Array<{ code: string }> }).debug_events)
      .toContainEqual(expect.objectContaining({ code: "generative_ui_shadow_matched" }));
  });

  it("records derivation failures without changing the legacy response or save", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    const oversized = "x".repeat(140 * 1024);
    const runner = vi.fn(async (input: { session_id?: string }) => resultWithWidget(input, { payload: oversized }));
    _setHostCodexManagerAgentRunnerForTest(runner);

    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Keep the oversized legacy payload." }),
    });
    const body = await turn.json() as {
      data: { workspace: { widgets: Array<{ data: { payload: string } }>; debug_events: Array<{ code: string }> } };
    };

    expect(turn.status).toBe(200);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(body.data.workspace.widgets[0].data.payload).toHaveLength(oversized.length);
    expect(body.data.workspace.debug_events).toContainEqual(expect.objectContaining({
      code: "generative_ui_shadow_error",
    }));
    expect(_getGenerativeUiShadowForTest(sessionId) as ShadowState).toMatchObject({
      snapshot: {
        status: "error",
        legacy_widget_count: 1,
        transaction_status: "error",
        document_revision: 0,
        matched: false,
      },
      document: null,
    });

    const loaded = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}`);
    const loadedBody = await loaded.json() as { data: { widgets: Array<{ data: { payload: string } }> } };
    expect(loaded.status).toBe(200);
    expect(loadedBody.data.widgets[0].data.payload).toHaveLength(oversized.length);
  });
});

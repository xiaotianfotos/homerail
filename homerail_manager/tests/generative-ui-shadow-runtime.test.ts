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

async function configure(baseUrl: string, mode: "off" | "shadow"): Promise<void> {
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

  it("keeps the exact legacy path when the session snapshot is off", async () => {
    await configure(baseUrl, "off");
    const sessionId = await createSession(baseUrl);
    const runner = vi.fn(async (input: { session_id?: string }) => resultWithWidget(input));
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
    expect(body.data.workspace.widgets.map((item) => item.id)).toEqual(["shadow-note"]);
    expect(body.data.workspace.debug_events.some((event) => event.code.startsWith("generative_ui_shadow"))).toBe(false);
    expect(_getGenerativeUiShadowForTest(sessionId)).toEqual({ snapshot: null, document: null });
    expect((await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/generative-ui`)).status).toBe(404);
  });

  it("honors global off as a reversible emergency kill switch", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    const runner = vi.fn(async (input: { session_id?: string }) => resultWithWidget(input));
    _setHostCodexManagerAgentRunnerForTest(runner);

    process.env[GENERATIVE_UI_MODE_ENV] = "off";
    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Temporarily disable shadow." }),
    });
    expect(turn.status).toBe(200);
    expect(_getGenerativeUiShadowForTest(sessionId)).toEqual({ snapshot: null, document: null });

    delete process.env[GENERATIVE_UI_MODE_ENV];
    const resumed = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/manager-status`, { method: "POST" });
    expect(resumed.status).toBe(200);
    expect(_getGenerativeUiShadowForTest(sessionId) as ShadowState).toMatchObject({
      snapshot: { legacy_widget_count: 1, transaction_status: "applied", document_revision: 1, matched: true },
      document: { revision: 1, nodes: [{ id: "shadow-note" }] },
    });
  });

  it("honors persisted off for an existing shadow session when no environment override exists", async () => {
    await configure(baseUrl, "shadow");
    const sessionId = await createSession(baseUrl);
    await configure(baseUrl, "off");
    _setHostCodexManagerAgentRunnerForTest(async (input) => resultWithWidget(input));

    const turn = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Disable through persisted config." }),
    });

    expect(turn.status).toBe(200);
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

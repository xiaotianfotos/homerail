import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GENERATIVE_UI_MODE_ENV } from "../src/generative-ui/mode.js";
import { applyVoiceCanonicalProjectionPatch } from "../src/generative-ui/canonical-voice-service.js";
import { closeDb } from "../src/persistence/db.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("Generative UI mode Manager and Voice config wiring", () => {
  let server: http.Server;
  let tmpHome: string;
  let oldHome: string | undefined;
  let oldMode: string | undefined;

  beforeEach(() => {
    closeDb();
    oldHome = process.env.HOMERAIL_HOME;
    oldMode = process.env[GENERATIVE_UI_MODE_ENV];
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-generative-ui-mode-"));
    process.env.HOMERAIL_HOME = tmpHome;
    delete process.env[GENERATIVE_UI_MODE_ENV];
    server = createServer(0, undefined, undefined, false, { autoDetectCodex: false });
  });

  afterEach(async () => {
    if (server.listening) await close(server);
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    if (oldMode === undefined) delete process.env[GENERATIVE_UI_MODE_ENV];
    else process.env[GENERATIVE_UI_MODE_ENV] = oldMode;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("defaults config and newly created Voice sessions to off", async () => {
    const port = await listen(server);
    const configResponse = await fetch(`http://127.0.0.1:${port}/api/manager-agent/config`);
    const configBody = await configResponse.json() as { data: { generative_ui_mode: string } };
    expect(configResponse.status).toBe(200);
    expect(configBody.data.generative_ui_mode).toBe("off");

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const sessionBody = await sessionResponse.json() as { data: { generative_ui_mode: string } };
    expect(sessionResponse.status).toBe(201);
    expect(sessionBody.data.generative_ui_mode).toBe("off");
  });

  it("persists shadow and snapshots it on new Voice sessions", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saveResponse = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generative_ui_mode: "shadow" }),
    });
    const saveBody = await saveResponse.json() as {
      data: {
        generative_ui_mode: string;
        effective_generative_ui_mode: string;
        generative_ui_mode_source: string;
      };
    };
    expect(saveResponse.status).toBe(200);
    expect(saveBody.data.generative_ui_mode).toBe("shadow");
    expect(saveBody.data.effective_generative_ui_mode).toBe("shadow");
    expect(saveBody.data.generative_ui_mode_source).toBe("configured");

    const sessionResponse = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const sessionBody = await sessionResponse.json() as { data: { session_id: string; generative_ui_mode: string } };
    expect(sessionBody.data.generative_ui_mode).toBe("shadow");

    const disableResponse = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generative_ui_mode: "off" }),
    });
    expect(disableResponse.status).toBe(200);

    const storedResponse = await fetch(`${baseUrl}/api/voice-agent/sessions/${sessionBody.data.session_id}`);
    const storedBody = await storedResponse.json() as { data: { generative_ui_mode: string } };
    expect(storedBody.data.generative_ui_mode).toBe("shadow");
  });

  it("uses the environment off override for newly created sessions", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saveResponse = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generative_ui_mode: "shadow" }),
    });
    expect(saveResponse.status).toBe(200);

    process.env[GENERATIVE_UI_MODE_ENV] = "off";
    const effectiveResponse = await fetch(`${baseUrl}/api/manager-agent/config`);
    const effectiveBody = await effectiveResponse.json() as {
      data: {
        generative_ui_mode: string;
        effective_generative_ui_mode: string;
        generative_ui_mode_source: string;
      };
    };
    expect(effectiveBody.data).toMatchObject({
      generative_ui_mode: "shadow",
      effective_generative_ui_mode: "off",
      generative_ui_mode_source: "environment",
    });
    const sessionResponse = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const sessionBody = await sessionResponse.json() as { data: { generative_ui_mode: string } };
    expect(sessionBody.data.generative_ui_mode).toBe("off");
  });

  it("enables prefer without making it the default and exposes only a non-empty canonical projection", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const saveResponse = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generative_ui_mode: "prefer" }),
    });
    expect(await saveResponse.json()).toMatchObject({
      data: {
        generative_ui_mode: "prefer",
        effective_generative_ui_mode: "prefer",
      },
    });
    const sessionResponse = await fetch(`${baseUrl}/api/voice-agent/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const session = await sessionResponse.json() as {
      data: { session_id: string; generative_ui_mode: string; widgets: unknown[] };
    };
    expect(session.data).toMatchObject({ generative_ui_mode: "prefer", widgets: [] });
    const projectionUrl = `${baseUrl}/api/voice-agent/sessions/${session.data.session_id}/generative-ui`;
    expect((await fetch(projectionUrl)).status).toBe(404);

    applyVoiceCanonicalProjectionPatch({
      session_id: session.data.session_id,
      patch: {
        base_revision: 0,
        upsert: [{
          ir_version: 1,
          id: "prefer-topic",
          kind: "com.homerail.topic-outline/outline",
          kind_version: 1,
          owner: { id: "com.homerail.topic-outline", version: "1.0.0" },
          surface: "task",
          importance: "primary",
          content: { title: "Prefer is authoritative" },
          lifecycle: { persistence: "session" },
          fallback: { title: "Prefer is authoritative" },
        }],
        remove_ids: [],
      },
      created_at: "2026-07-12T02:00:00.000Z",
    });
    const projectionResponse = await fetch(projectionUrl);
    expect(projectionResponse.status).toBe(200);
    expect(await projectionResponse.json()).toMatchObject({
      data: {
        mode: "prefer",
        authoritative: true,
        purpose: "canonical",
        document: { revision: 1, nodes: [{ id: "prefer-topic" }] },
      },
    });
    const streamResponse = await fetch(`${projectionUrl}/stream`);
    expect(streamResponse.status).toBe(200);
    const [snapshot] = (await streamResponse.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(snapshot).toMatchObject({
      event: "snapshot",
      stream_version: 1,
      mode: "prefer",
      authoritative: true,
      purpose: "canonical",
      pending_tool_confirmations: [],
      document: { revision: 1, nodes: [{ id: "prefer-topic" }] },
    });

    const workspace = await (await fetch(
      `${baseUrl}/api/voice-agent/sessions/${session.data.session_id}`,
    )).json();
    expect(workspace).toMatchObject({
      data: { generative_ui_mode: "prefer", widgets: [] },
    });

    process.env[GENERATIVE_UI_MODE_ENV] = "strict";
    expect((await fetch(projectionUrl)).status).toBe(404);
    delete process.env[GENERATIVE_UI_MODE_ENV];
  });

  it("rejects reserved strict without changing persisted configuration", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const response = await fetch(`${baseUrl}/api/voice-agent/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generative_ui_mode: "strict" }),
    });
    const body = await response.json() as { error: string };
    expect(response.status).toBe(400);
    expect(body.error).toContain("reserved and is not available");

    const storedResponse = await fetch(`${baseUrl}/api/manager-agent/config`);
    const storedBody = await storedResponse.json() as { data: { generative_ui_mode: string } };
    expect(storedBody.data.generative_ui_mode).toBe("off");
  });

  it("does not persist Manager or Voice config patches under an invalid environment override", async () => {
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    process.env[GENERATIVE_UI_MODE_ENV] = "strict";

    for (const endpoint of ["/api/manager-agent/config", "/api/voice-agent/config"]) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: `must-not-persist:${endpoint}` }),
      });
      expect(response.status).toBe(500);
    }

    delete process.env[GENERATIVE_UI_MODE_ENV];
    const storedResponse = await fetch(`${baseUrl}/api/manager-agent/config`);
    const storedBody = await storedResponse.json() as { data: { system_prompt: string } };
    expect(storedResponse.status).toBe(200);
    expect(storedBody.data.system_prompt).toBe("");
  });
});

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/persistence/db.js";
import { createServer } from "../src/server/http.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("plugin capability read routes", () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpHome: string;
  let previousHome: string | undefined;
  let previousAutostart: string | undefined;

  beforeEach(async () => {
    closeDb();
    previousHome = process.env.HOMERAIL_HOME;
    previousAutostart = process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-capability-routes-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    server = createServer(0, undefined, undefined, false);
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    if (server.listening) await close(server);
    closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = previousHome;
    if (previousAutostart === undefined) delete process.env.HOMERAIL_LOCAL_NODE_AUTOSTART;
    else process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = previousAutostart;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("serves a cacheable compact capability index", async () => {
    const response = await fetch(`${baseUrl}/api/plugins/capabilities`);
    const etag = response.headers.get("etag")!;
    const body = await response.json() as {
      data: {
        entries: Array<{ qualified_id: string; skill: Record<string, unknown> }>;
        index_digest: string;
      };
    };
    expect(response.status).toBe(200);
    expect(body.data.entries.map((entry) => entry.qualified_id)).toEqual([
      "com.homerail.core:voice-generative-ui",
      "com.homerail.pr-closeout:summarize-pr-closeout",
      "com.homerail.topic-outline:compose-outline",
    ]);
    expect(JSON.stringify(body.data.entries)).not.toContain("# Topic Outline");
    expect(etag).toContain(body.data.index_digest);
    expect((await fetch(`${baseUrl}/api/plugins/capabilities`, {
      headers: { "If-None-Match": etag },
    })).status).toBe(304);
  });

  it("selects under a bounded prompt without mutating registry state", async () => {
    const registryBefore = await (await fetch(`${baseUrl}/api/plugins`)).json() as {
      data: { registry_fingerprint: string };
    };
    const response = await fetch(`${baseUrl}/api/plugins/capabilities/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        utterance: "create a topic outline",
        modality: "voice",
        inputs: { title: "Route test" },
        top_k: 1,
        prompt_byte_budget: 16 * 1024,
      }),
    });
    const body = await response.json() as {
      data: {
        selected: Array<{ capability_id: string }>;
        selected_context: { skills: Array<{ qualified_id: string }>; tools: Array<{ qualified_id: string }> };
        prompt_bytes: number;
        prompt_byte_budget: number;
        replay: { result_digest: string };
      };
    };
    expect(response.status).toBe(200);
    expect(body.data.selected).toEqual([expect.objectContaining({
      capability_id: "com.homerail.topic-outline:compose-outline",
    })]);
    expect(body.data.selected_context.skills.map((skill) => skill.qualified_id))
      .toEqual(["com.homerail.topic-outline:topic-outline"]);
    expect(body.data.selected_context.tools.map((tool) => tool.qualified_id))
      .toEqual(["com.homerail.topic-outline:upsert_topic_outline"]);
    expect(body.data.prompt_bytes).toBeLessThanOrEqual(body.data.prompt_byte_budget);
    expect(body.data.replay.result_digest).toMatch(/^[a-f0-9]{64}$/);
    const registryAfter = await (await fetch(`${baseUrl}/api/plugins`)).json() as {
      data: { registry_fingerprint: string };
    };
    expect(registryAfter.data.registry_fingerprint).toBe(registryBefore.data.registry_fingerprint);
  });

  it("returns blocked and validation results without leaking unselected schemas", async () => {
    const missing = await fetch(`${baseUrl}/api/plugins/capabilities/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance: "create a topic outline", modality: "voice" }),
    });
    const missingBody = await missing.json() as {
      data: {
        candidates: Array<{ status: string; missing_inputs: string[] }>;
        selected_context: { skills: unknown[]; tools: unknown[] };
      };
    };
    expect(missing.status).toBe(200);
    expect(missingBody.data.candidates[0]).toMatchObject({ status: "needs_input", missing_inputs: ["title"] });
    expect(missingBody.data.selected_context).toMatchObject({ skills: [], tools: [] });

    const invalid = await fetch(`${baseUrl}/api/plugins/capabilities/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ utterance: "x", modality: "telepathy" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(expect.objectContaining({ success: false }));
  });
});

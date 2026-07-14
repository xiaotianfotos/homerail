import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  _requestManagerForTest,
  managerAgentChildEnv,
} from "../src/server/host-codex-manager-agent.js";

const TOKEN = "host-manager-admin-token-0123456789abcdef";
const originalToken = process.env.HOMERAIL_MANAGER_ADMIN_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.HOMERAIL_MANAGER_ADMIN_TOKEN;
  else process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = originalToken;
});

describe("host Manager Agent REST authentication", () => {
  it("keeps the Manager credential out of Agent subprocess environments", () => {
    const source = {
      HOMERAIL_MANAGER_ADMIN_TOKEN: TOKEN,
      HOMERAIL_PLUGIN_CAPABILITY_SECRET: "capability-secret",
      OPENAI_API_KEY: "provider-key",
      PATH: "/usr/bin",
    };
    expect(managerAgentChildEnv(source)).toEqual({
      OPENAI_API_KEY: "provider-key",
      PATH: "/usr/bin",
    });
    expect(source.HOMERAIL_MANAGER_ADMIN_TOKEN).toBe(TOKEN);
    expect(source.HOMERAIL_PLUGIN_CAPABILITY_SECRET).toBe("capability-secret");
  });

  it("adds Bearer only to /api mutations and redacts Manager errors", async () => {
    const observed: Array<{ method?: string; authorization?: string }> = [];
    const server = http.createServer((req, res) => {
      observed.push({ method: req.method, authorization: req.headers.authorization });
      req.resume();
      if (req.url === "/api/error") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `bad Bearer ${TOKEN}; credential=${TOKEN}` }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    const restUrl = await listen(server);
    process.env.HOMERAIL_MANAGER_ADMIN_TOKEN = TOKEN;

    try {
      await expect(_requestManagerForTest(restUrl, "/read")).resolves.toEqual({ success: true });
      await expect(_requestManagerForTest(restUrl, "/write", {
        method: "POST",
        headers: { Authorization: "Bearer caller-controlled" },
        body: "{}",
      })).resolves.toEqual({ success: true });
      expect(observed.slice(0, 2)).toEqual([
        { method: "GET", authorization: undefined },
        { method: "POST", authorization: `Bearer ${TOKEN}` },
      ]);

      let error = "";
      try {
        await _requestManagerForTest(restUrl, "/error", { method: "DELETE" });
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      expect(error).toContain("REDACTED");
      expect(error).not.toContain(TOKEN);
    } finally {
      await close(server);
    }
  });
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}/api`;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

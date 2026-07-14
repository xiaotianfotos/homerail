import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/persistence/db.js";
import { createServer } from "../src/server/http.js";
import { _requestManagerForTest } from "../src/server/host-codex-manager-agent.js";
import {
  HOMERAIL_MANAGER_ADMIN_ORIGINS,
  HOMERAIL_MANAGER_ADMIN_TOKEN,
  HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH,
  createPluginHttpTrustPolicy,
  isLoopbackHost,
} from "../src/server/plugin-http-trust.js";

const VALID_TOKEN = "m5-test-admin-token-0123456789abcdef";
const TRUSTED_ORIGIN = "http://127.0.0.1:19193";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("Manager HTTP mutation trust gate", () => {
  let server: http.Server | undefined;
  let baseUrl = "";
  let tmpHome: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    closeDb();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-plugin-http-trust-"));
    process.env.HOMERAIL_HOME = tmpHome;
    process.env.HOMERAIL_LOCAL_NODE_AUTOSTART = "0";
    delete process.env.HOMERAIL_MANAGER_HOST;
    delete process.env.HOMERAIL_MANAGER_PUBLIC_URL;
    delete process.env[HOMERAIL_MANAGER_ADMIN_TOKEN];
    delete process.env[HOMERAIL_MANAGER_ADMIN_ORIGINS];
    delete process.env[HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH];
  });

  afterEach(async () => {
    await close(server);
    closeDb();
    process.env = savedEnv;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function start(): Promise<void> {
    server = createServer(0, undefined, undefined, false);
    baseUrl = await listen(server);
  }

  it("allows a default loopback CLI without Origin while rejecting browser CSRF", async () => {
    await start();

    const cli = await fetch(`${baseUrl}/api/plugins/install`, { method: "POST" });
    expect(cli.status).toBe(415); // Reached the install route; the trust gate allowed it.
    expect(cli.headers.get("access-control-allow-origin")).toBeNull();

    const crossSite = await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("access-control-allow-origin")).toBeNull();

    const missingOriginBrowser = await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(missingOriginBrowser.status).toBe(403);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it("guards every /api mutation before route parsing or side effects", async () => {
    await start();
    const writes: Array<[string, string]> = [
      ["POST", "/api/plugins/install"],
      ["PUT", "/api/plugins/com.example.demo/permissions"],
      ["PUT", "/api/plugins/com.example.demo/enabled"],
      ["PUT", "/api/plugins/com.example.demo/active-version"],
      ["POST", "/api/plugins/com.example.demo/rollback"],
      ["DELETE", "/api/plugins/com.example.demo"],
      ["POST", "/api/runs"],
      ["PUT", "/api/manager-agent/config"],
      ["PATCH", "/api/not-yet-registered"],
      ["DELETE", "/api/not-yet-registered"],
    ];
    for (const [method, pathname] of writes) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status, `${method} ${pathname}`).toBe(403);
    }
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it("allows an explicitly trusted local UI Origin without weakening loopback CLI mode", async () => {
    process.env[HOMERAIL_MANAGER_ADMIN_ORIGINS] = TRUSTED_ORIGIN;
    await start();

    const trusted = await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { Origin: TRUSTED_ORIGIN },
    });
    expect(trusted.status).toBe(415);
    expect(trusted.headers.get("access-control-allow-origin")).toBe(TRUSTED_ORIGIN);
    expect(trusted.headers.get("access-control-allow-credentials")).toBeNull();

    const emptyOrigin = await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { Origin: "" },
    });
    expect(emptyOrigin.status).toBe(403);
  });

  it("requires a constant-time Bearer credential when a token is configured", async () => {
    process.env[HOMERAIL_MANAGER_ADMIN_TOKEN] = VALID_TOKEN;
    await start();

    expect((await fetch(`${baseUrl}/api/plugins/install`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { Authorization: "Bearer definitely-wrong" },
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    })).status).toBe(415);
    expect((await fetch(`${baseUrl}/api/plugins`)).status).toBe(200);
  });

  it("fails server creation closed for LAN/public configuration without a strong token", () => {
    process.env.HOMERAIL_MANAGER_HOST = "0.0.0.0";
    expect(() => createServer(0, undefined, undefined, false)).toThrow(HOMERAIL_MANAGER_ADMIN_TOKEN);

    process.env[HOMERAIL_MANAGER_ADMIN_TOKEN] = "short";
    expect(() => createServer(0, undefined, undefined, false)).toThrow("32-4096");

    process.env.HOMERAIL_MANAGER_HOST = "127.0.0.1";
    delete process.env[HOMERAIL_MANAGER_ADMIN_TOKEN];
    process.env.HOMERAIL_MANAGER_PUBLIC_URL = "https://manager.example.test";
    expect(() => createServer(0, undefined, undefined, false)).toThrow(HOMERAIL_MANAGER_ADMIN_TOKEN);
  });

  it("allows LAN operation only with the correct token", async () => {
    process.env.HOMERAIL_MANAGER_HOST = "0.0.0.0";
    process.env[HOMERAIL_MANAGER_ADMIN_TOKEN] = VALID_TOKEN;
    await start();

    expect((await fetch(`${baseUrl}/api/plugins/install`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    })).status).toBe(415);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it("allows an explicit unsafe public test runtime without a token while retaining Origin checks", async () => {
    process.env.HOMERAIL_MANAGER_HOST = "0.0.0.0";
    process.env[HOMERAIL_MANAGER_ADMIN_ORIGINS] = TRUSTED_ORIGIN;
    process.env[HOMERAIL_UNSAFE_ALLOW_PUBLIC_MANAGER_WITHOUT_AUTH] = "1";
    await start();

    const trustedBrowser = await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { Origin: TRUSTED_ORIGIN },
    });
    expect(trustedBrowser.status).toBe(415);
    expect(trustedBrowser.headers.get("access-control-allow-origin")).toBe(TRUSTED_ORIGIN);

    const crossSite = await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);

    const testCli = await fetch(`${baseUrl}/api/not-yet-registered`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(testCli.status).toBe(404);
  });

  it("supports exact trusted UI origins and secure mutation preflights", async () => {
    process.env[HOMERAIL_MANAGER_ADMIN_TOKEN] = VALID_TOKEN;
    process.env[HOMERAIL_MANAGER_ADMIN_ORIGINS] = TRUSTED_ORIGIN;
    await start();

    const preflight = await fetch(`${baseUrl}/api/manager-agent/config`, {
      method: "OPTIONS",
      headers: {
        Origin: TRUSTED_ORIGIN,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(TRUSTED_ORIGIN);
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(preflight.headers.get("vary")).toContain("Origin");

    const actual = await fetch(`${baseUrl}/api/plugins/install`, {
      method: "POST",
      headers: { Origin: TRUSTED_ORIGIN, Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(actual.status).toBe(415);
    expect(actual.headers.get("access-control-allow-origin")).toBe(TRUSTED_ORIGIN);
    expect(actual.headers.get("access-control-allow-credentials")).toBeNull();

    const untrusted = await fetch(`${baseUrl}/api/plugins/install`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(untrusted.status).toBe(403);
    expect(untrusted.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps read APIs public and rejects wildcard or non-origin allowlist entries", async () => {
    await start();
    const read = await fetch(`${baseUrl}/api/plugins`);
    expect(read.status).toBe(200);
    expect(read.headers.get("access-control-allow-origin")).toBe("*");

    const readPreflight = await fetch(`${baseUrl}/api/plugins`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://reader.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(readPreflight.status).toBe(204);
    expect(readPreflight.headers.get("access-control-allow-origin")).toBe("*");

    expect(() => createPluginHttpTrustPolicy({ allowedOrigins: "*" })).toThrow("exact");
    expect(() => createPluginHttpTrustPolicy({ allowedOrigins: "https://ui.example/path" })).toThrow("exact");
  });

  it("allows a public no-Origin CLI equivalent only with Bearer auth", async () => {
    process.env.HOMERAIL_MANAGER_HOST = "0.0.0.0";
    process.env[HOMERAIL_MANAGER_ADMIN_TOKEN] = VALID_TOKEN;
    await start();

    const deniedCurl = await fetch(`${baseUrl}/api/not-yet-registered`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(deniedCurl.status).toBe(401);

    const authenticatedCurl = await fetch(`${baseUrl}/api/not-yet-registered`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${VALID_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(authenticatedCurl.status).toBe(404);
    expect(authenticatedCurl.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps the Host Manager Agent mutation path authenticated against the real public gate", async () => {
    process.env.HOMERAIL_MANAGER_HOST = "0.0.0.0";
    process.env[HOMERAIL_MANAGER_ADMIN_TOKEN] = VALID_TOKEN;
    await start();

    await expect(_requestManagerForTest(`${baseUrl}/api`, "/plugins/install", {
      method: "POST",
      body: "{}",
    })).rejects.toThrow("Manager API 415");

    delete process.env[HOMERAIL_MANAGER_ADMIN_TOKEN];
    await expect(_requestManagerForTest(`${baseUrl}/api`, "/plugins/install", {
      method: "POST",
      body: "{}",
    })).rejects.toThrow("Manager API 401");
  });

  it("classifies IPv4 and IPv6 loopback conservatively", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.44.3.9")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
  });
});

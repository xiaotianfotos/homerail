import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { buildSync } from "esbuild";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";

const children: ChildProcess[] = [];
const servers: http.Server[] = [];
const sockets = new Set<net.Socket>();
const unexpectedSocketErrors: Error[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const child of children.splice(0)) {
    await stopChild(child);
  }
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const errors = unexpectedSocketErrors.splice(0);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Unexpected WebSocket errors during static UI proxy teardown");
  }
});

describe("static Agent UI mutation proxy", () => {
  it("proxies the Manager event WebSocket used by runtime environment updates", async () => {
    let upgradedPath = "";
    const manager = http.createServer();
    manager.on("upgrade", (req, socket) => {
      trackSocket(socket);
      upgradedPath = req.url || "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
      socket.end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    const response = await websocketUpgrade(uiPort, "/ws/events");
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(upgradedPath).toBe("/ws/events");
  }, 15_000);

  it("builds and proxies Manager events through the packaged UI artifacts", async () => {
    buildPackagedUiArtifacts();
    const packagedUiRoot = path.resolve("..", "agent-ui", "dist");
    const packagedServer = path.resolve("dist", "static-ui-server.js");
    expect(fs.existsSync(packagedServer)).toBe(true);
    expect(fs.existsSync(path.join(packagedUiRoot, "index.html"))).toBe(true);

    let upgradedPath = "";
    const manager = http.createServer();
    manager.on("upgrade", (req, socket) => {
      trackSocket(socket);
      upgradedPath = req.url || "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
      socket.end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
      root: packagedUiRoot,
      entry: "dist",
    });

    const page = await fetch(uiOrigin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-hr-appearance="cockpit"');
    const manifest = await fetch(`${uiOrigin}/homerail-build.json`);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ app: "homerail-agent-ui" });

    const response = await websocketUpgrade(uiPort, "/ws/events", uiOrigin);
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(upgradedPath).toBe("/ws/events");
  }, 180_000);

  it("proxies the same-origin ASR realtime WebSocket to the Manager", async () => {
    let upgradedPath = "";
    const manager = http.createServer();
    manager.on("upgrade", (req, socket) => {
      trackSocket(socket);
      upgradedPath = req.url || "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
      socket.end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    const response = await websocketUpgrade(uiPort, "/api/voice/asr/realtime");
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(upgradedPath).toBe("/api/voice/asr/realtime");
  }, 15_000);

  it("stays available when the Manager resets an upgraded WebSocket", async () => {
    const manager = http.createServer();
    manager.on("upgrade", (_req, socket) => {
      trackSocket(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
        () => socket.resetAndDestroy(),
      );
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    expect(await websocketUpgradeHeaders(uiPort, "/ws/events")).toContain(
      "HTTP/1.1 101 Switching Protocols",
    );
    await waitUntil(async () => (await fetch(uiOrigin)).status === 200);
  }, 15_000);

  it("stays available when the browser resets an upgraded WebSocket", async () => {
    const manager = http.createServer();
    manager.on("upgrade", (_req, socket) => {
      trackSocket(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    expect(await websocketUpgradeHeaders(uiPort, "/ws/events", true)).toContain(
      "HTTP/1.1 101 Switching Protocols",
    );
    await waitUntil(async () => (await fetch(uiOrigin)).status === 200);
  }, 15_000);

  it("proxies the dynamic Codex Live Voice WebSocket to the Manager unchanged", async () => {
    let upgradedPath = "";
    const manager = http.createServer();
    manager.on("upgrade", (req, socket) => {
      trackSocket(socket);
      upgradedPath = req.url || "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "\r\n",
      );
      socket.end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    // Dynamic sessionId path: the matcher must accept any non-empty id segment
    // and forward the path verbatim so Manager's Codex Live Voice handler keeps
    // ownership of the route.
    const sessionId = "01HK5CWD6YZ7EV1XBWG3V8N9P0";
    const livePath = `/api/voice-agent/sessions/${sessionId}/live`;
    const response = await websocketUpgrade(uiPort, livePath, uiOrigin);
    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(upgradedPath).toBe(livePath);
  }, 15_000);

  it("destroys WebSocket upgrades on voice-agent routes outside the live allowlist", async () => {
    let managerUpgrades = 0;
    const manager = http.createServer();
    manager.on("upgrade", (_req, socket) => {
      // These paths must never reach Manager. If one does, track the socket so
      // afterEach tears it down instead of leaking it into the next test.
      trackSocket(socket);
      managerUpgrades++;
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
    });

    // Look-alike paths that must NOT be forwarded: an extra trailing segment, an
    // empty id, and a different voice-agent endpoint. The matcher is anchored, so
    // each of these should fall through to socket.destroy() and never reach Manager.
    // A destroyed upgrade closes the socket without a 101 Switching Protocols line.
    for (const badPath of [
      "/api/voice-agent/sessions/01HK5CWD6YZ7EV1XBWG3V8N9P0/live/extra",
      "/api/voice-agent/sessions//live",
      "/api/voice-agent/sessions/01HK5CWD6YZ7EV1XBWG3V8N9P0/ticket",
    ]) {
      const response = await websocketUpgrade(uiPort, badPath, uiOrigin).catch((reason) => String(reason));
      expect(response).not.toContain("HTTP/1.1 101 Switching Protocols");
    }
    expect(managerUpgrades).toBe(0);
  }, 15_000);

  it("rejects no-Origin/cross-origin requests and proxies exact self-Origin without credentials", async () => {
    const received: Array<{ authorization?: string; origin?: string; method?: string; mutationToken?: string }> = [];
    const manager = http.createServer((req, res) => {
      received.push({
        authorization: req.headers.authorization,
        origin: req.headers.origin,
        method: req.method,
        mutationToken: typeof req.headers["x-homerail-dag-token"] === "string"
          ? req.headers["x-homerail-dag-token"]
          : undefined,
      });
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
      mutationToken: "internal-mutation-token",
    });

    expect((await fetch(`${uiOrigin}/api/runs`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    })).status).toBe(403);
    expect(received).toHaveLength(0);

    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: {
        Origin: uiOrigin,
        "x-homerail-dag-token": "browser-supplied-token",
      },
    })).status).toBe(200);
    expect(received[0]).toEqual({
      authorization: undefined,
      origin: uiOrigin,
      method: "POST",
      mutationToken: "internal-mutation-token",
    });

    expect((await fetch(`${uiOrigin}/api/read`)).status).toBe(200);
    expect(received[1]?.authorization).toBeUndefined();
    expect(received[1]?.mutationToken).toBeUndefined();
  }, 15_000);

  it("accepts the configured external Origin through an FN Connect-style Host rewrite", async () => {
    const received: Array<{ authorization?: string; origin?: string; method?: string; mutationToken?: string }> = [];
    const manager = http.createServer((req, res) => {
      received.push({
        authorization: req.headers.authorization,
        origin: req.headers.origin,
        method: req.method,
        mutationToken: typeof req.headers["x-homerail-dag-token"] === "string"
          ? req.headers["x-homerail-dag-token"]
          : undefined,
      });
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
      mutationToken: "internal-mutation-token",
      publicUrl: "https://external.example",
    });

    // The reverse proxy presents the external browser Origin while forwarding
    // with the internal Host (127.0.0.1:<port>) it bound to.
    const response = await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: {
        Origin: "https://external.example",
        "Sec-Fetch-Site": "same-origin",
        Authorization: "Bearer browser-supplied",
        "x-homerail-dag-token": "browser-supplied-token",
      },
    });
    expect(response.status).toBe(200);
    expect(received[0]).toEqual({
      authorization: undefined,
      origin: "https://external.example",
      method: "POST",
      mutationToken: "internal-mutation-token",
    });

    // Direct local access keeps working through the request-derived Origin.
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: uiOrigin, "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(200);
    expect(received[1]?.origin).toBe(uiOrigin);

    // Read-only API requests stay unaffected by the Origin policy.
    expect((await fetch(`${uiOrigin}/api/read`)).status).toBe(200);
    expect(received[2]?.mutationToken).toBeUndefined();
  }, 15_000);

  it("keeps rejecting missing, malformed, unrelated, and cross-site mutations with a configured external Origin", async () => {
    let managerHits = 0;
    const manager = http.createServer((req, res) => {
      managerHits++;
      req.resume();
      res.writeHead(200).end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
      mutationToken: "internal-mutation-token",
      publicUrl: "https://external.example",
    });

    expect((await fetch(`${uiOrigin}/api/runs`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(403);
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: "not-a-url", "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(403);
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(403);
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: "https://external.example", "Sec-Fetch-Site": "cross-site" },
    })).status).toBe(403);
    expect(managerHits).toBe(0);
  }, 15_000);

  it("preserves strict request-derived behavior without a configured public Origin", async () => {
    let managerHits = 0;
    const manager = http.createServer((req, res) => {
      managerHits++;
      req.resume();
      res.writeHead(200).end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({ port: uiPort, host: "127.0.0.1", origin: uiOrigin, managerUrl });

    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: "https://external.example", "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(403);
    expect(managerHits).toBe(0);

    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: uiOrigin, "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(200);
    expect(managerHits).toBe(1);
  }, 15_000);

  it("does not trust forged Forwarded or X-Forwarded-Host headers", async () => {
    let managerHits = 0;
    const manager = http.createServer((req, res) => {
      managerHits++;
      req.resume();
      res.writeHead(200).end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl,
      mutationToken: "internal-mutation-token",
      publicUrl: "https://external.example",
    });

    // Forged forwarding headers alone cannot make an unrelated Origin pass,
    // with or without a configured public Origin.
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "same-origin",
        Forwarded: "for=192.0.2.1;host=external.example;proto=https",
        "X-Forwarded-Host": "external.example",
        "X-Forwarded-Proto": "https",
      },
    })).status).toBe(403);
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: {
        Origin: "https://external.example",
        "Sec-Fetch-Site": "cross-site",
        Forwarded: "host=external.example;proto=https",
        "X-Forwarded-Host": "external.example",
      },
    })).status).toBe(403);
    expect(managerHits).toBe(0);

    // Positive control: the same proxy headers do not break a legitimate
    // configured-Origin mutation.
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: {
        Origin: "https://external.example",
        "Sec-Fetch-Site": "same-origin",
        Forwarded: "host=external.example;proto=https",
        "X-Forwarded-Host": "external.example",
      },
    })).status).toBe(200);
    expect(managerHits).toBe(1);
  }, 15_000);

  it("fails closed when HOMERAIL_UI_PUBLIC_URL is not an exact http(s) Origin", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-static-ui-invalid-"));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>test</title>");
    const uiPort = await reservePort();
    const child = spawn(process.execPath, [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("src/static-ui-server.ts"),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOMERAIL_STATIC_UI_DIR: root,
        HOMERAIL_UI_PORT: String(uiPort),
        HOMERAIL_UI_HOST: "127.0.0.1",
        HOMERAIL_UI_HTTPS: "0",
        HOMERAIL_MANAGER_HTTP: "http://127.0.0.1:1",
        HOMERAIL_MANAGER_WS: "ws://127.0.0.1:1",
        HOMERAIL_UI_PUBLIC_URL: "https://external.example/ui",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stdout?.resume();
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("HOMERAIL_UI_PUBLIC_URL must be an exact http(s) Origin");
  }, 15_000);

  it("derives the self Origin for a publicly bound development server", async () => {
    let managerHits = 0;
    let receivedMutationToken: string | undefined;
    const manager = http.createServer((req, res) => {
      managerHits++;
      receivedMutationToken = typeof req.headers["x-homerail-dag-token"] === "string"
        ? req.headers["x-homerail-dag-token"]
        : undefined;
      req.resume();
      res.writeHead(200).end();
    });
    servers.push(manager);
    const managerUrl = await listen(manager, "127.0.0.1");
    const uiPort = await reservePort("0.0.0.0");
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({ port: uiPort, host: "0.0.0.0", origin: uiOrigin, managerUrl });

    const response = await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: {
        Origin: uiOrigin,
        "x-homerail-dag-token": "browser-supplied-token",
      },
    });
    expect(response.status).toBe(200);
    expect(managerHits).toBe(1);
    expect(receivedMutationToken).toBeUndefined();
  }, 15_000);

  it("rejects encoded traversal into a same-prefix sibling of the static root", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-static-ui-boundary-"));
    tempDirs.push(parent);
    const root = path.join(parent, "dist");
    const sibling = path.join(parent, "dist-secret");
    fs.mkdirSync(root);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>test</title>");
    fs.writeFileSync(path.join(sibling, "secret.txt"), "must-not-be-served");
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl: "http://127.0.0.1:1",
      root,
    });

    const response = await fetch(`${uiOrigin}/..%2fdist-secret/secret.txt`);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  }, 15_000);

  it("returns 400 for malformed percent encoding and remains available", async () => {
    const uiPort = await reservePort();
    const uiOrigin = `http://127.0.0.1:${uiPort}`;
    await startStaticUi({
      port: uiPort,
      host: "127.0.0.1",
      origin: uiOrigin,
      managerUrl: "http://127.0.0.1:1",
    });

    const malformed = await fetch(`${uiOrigin}/%`);
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    expect(await malformed.text()).toBe("bad request");

    const healthy = await fetch(`${uiOrigin}/`);
    expect(healthy.status).toBe(200);
    expect(await healthy.text()).toContain("<title>test</title>");
  }, 15_000);
});

async function startStaticUi(options: {
  port: number;
  host: string;
  origin: string;
  managerUrl: string;
  root?: string;
  mutationToken?: string;
  publicUrl?: string;
  entry?: "source" | "dist";
}): Promise<void> {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "homerail-static-ui-trust-"));
  if (!options.root) {
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>test</title>");
  }
  const args = options.entry === "dist"
    ? [path.resolve("dist/static-ui-server.js")]
    : [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("src/static-ui-server.ts"),
      ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOMERAIL_STATIC_UI_DIR: root,
      HOMERAIL_UI_PORT: String(options.port),
      HOMERAIL_UI_HOST: options.host,
      HOMERAIL_UI_HTTPS: "0",
      HOMERAIL_MANAGER_HTTP: options.managerUrl,
      HOMERAIL_MANAGER_WS: options.managerUrl.replace(/^http/, "ws"),
      ...(options.mutationToken ? { HOMERAIL_DAG_MUTATION_TOKEN: options.mutationToken } : {}),
      ...(options.publicUrl ? { HOMERAIL_UI_PUBLIC_URL: options.publicUrl } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
  child.stdout?.resume();
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(`static UI exited early: ${stderr}`);
    try {
      return (await fetch(options.origin)).status === 200;
    } catch {
      return false;
    }
  });
}

function buildPackagedUiArtifacts(): void {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required to build packaged UI test artifacts");
  for (const cwd of [process.cwd(), path.resolve("..", "agent-ui")]) {
    execFileSync(process.execPath, [npmCli, "run", "build"], {
      cwd,
      env: process.env,
      stdio: "pipe",
      timeout: 120_000,
    });
  }
}

async function listen(server: http.Server, host: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return `http://${host}:${address.port}`;
}

async function reservePort(host = "127.0.0.1"): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function websocketUpgrade(port: number, requestPath: string, origin?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = trackSocket(net.createConnection({ host: "127.0.0.1", port }));
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket upgrade timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        (origin ? `Origin: ${origin}\r\n` : "") +
        "\r\n",
      );
    });
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(response);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function websocketUpgradeHeaders(
  port: number,
  requestPath: string,
  resetClient = false,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = trackSocket(net.createConnection({ host: "127.0.0.1", port }));
    let response = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      if (resetClient) socket.resetAndDestroy();
      resolve(response);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("WebSocket upgrade timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `GET ${requestPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "\r\n",
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) finish();
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("WebSocket ended before upgrade headers"));
    });
    socket.on("error", (error) => {
      if (!settled) finish(error);
    });
  });
}

function trackSocket(socket: net.Socket): net.Socket {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
      unexpectedSocketErrors.push(error);
    }
  });
  return socket;
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const finish = (closed: boolean): void => {
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildClose(child, 5_000)) return;
  child.kill("SIGKILL");
  if (!await waitForChildClose(child, 2_000)) {
    throw new Error(`static UI child ${child.pid ?? "unknown"} did not exit`);
  }
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("static UI did not become ready");
}

describe("runtime UI Origin propagation through hr ui start", () => {
  afterAll(() => {
    if (sharedRuntimeRepoRoot) {
      fs.rmSync(sharedRuntimeRepoRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
      sharedRuntimeRepoRoot = undefined;
    }
  });

  afterEach(async () => {
    const stoppedPids: number[] = [];
    for (const harness of runtimeHarnesses.splice(0)) {
      for (const name of ["ui-https", "ui"] as const) {
        const pid = runtimePidFile(harness.home, name);
        if (pid === undefined) continue;
        stoppedPids.push(pid);
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Already exited.
          }
        }
      }
    }
    await Promise.all(stoppedPids.map((pid) => waitForRuntimePidExit(pid)));
  });

  it("propagates the explicit external Origin from flag, environment, and stored config into both static listeners", async () => {
    const harness = await createRuntimeHarness();
    fs.mkdirSync(path.join(harness.home, "secrets"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(harness.home, "secrets", "env"),
      "HOMERAIL_DAG_MUTATION_TOKEN=internal-mutation-token\n",
      { mode: 0o600 },
    );

    // Source 1: the CLI flag, deliberately non-canonical.
    const flag = await runUiStart(harness, ["--public-url", "https://UI.Example.test:443/"]);
    expect(flag.errors).toEqual([]);
    expect(flag.status.uiHttpsPidRunning).toBe(true);
    expect(flag.status.uiHttpPidRunning).toBe(true);

    // Both children are launched from one normalized Origin and the persisted
    // state records the effective authorization configuration.
    expect(runtimeStateFile(harness.home, "ui-https")?.explicitPublicUrl).toBe("https://ui.example.test");
    expect(runtimeStateFile(harness.home, "ui")?.explicitPublicUrl).toBe("https://ui.example.test");
    expect(flag.status.uiHttpsPublicUrl).toBe("https://ui.example.test");
    expect(flag.status.uiHttpPublicUrl).toBe("https://ui.example.test");

    for (const protocol of ["https", "http"] as const) {
      const port = protocol === "https" ? harness.httpsPort : harness.httpPort;
      // The external HTTPS Origin is accepted by both listeners; the HTTP
      // fallback covers TLS-terminating reverse proxies.
      expect((await mutationRequest({
        protocol,
        port,
        headers: {
          Origin: "https://ui.example.test",
          "Sec-Fetch-Site": "same-origin",
          Authorization: "Bearer browser-supplied",
          "x-homerail-dag-token": "browser-supplied-token",
        },
      })).status).toBe(200);
      // Unrelated Origins and cross-site submissions stay rejected.
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: "https://evil.example.test", "Sec-Fetch-Site": "same-origin" },
      })).status).toBe(403);
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: "https://ui.example.test", "Sec-Fetch-Site": "cross-site" },
      })).status).toBe(403);
    }

    // Browser credentials are stripped and the internal mutation token is
    // injected on the proxied hop for both listeners.
    expect(harness.received[0]).toMatchObject({
      origin: "https://ui.example.test",
      authorization: undefined,
      mutationToken: "internal-mutation-token",
    });
    expect(harness.received[1]).toMatchObject({
      origin: "https://ui.example.test",
      authorization: undefined,
      mutationToken: "internal-mutation-token",
    });

    // Direct local access keeps working through the request-derived Origin,
    // and read-only requests stay unaffected.
    const httpSelfOrigin = `http://127.0.0.1:${harness.httpPort}`;
    expect((await mutationRequest({
      protocol: "http",
      port: harness.httpPort,
      headers: { Origin: httpSelfOrigin, "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(200);
    expect((await mutationRequest({
      protocol: "http",
      port: harness.httpPort,
      method: "GET",
      path: "/api/read",
    })).status).toBe(200);

    // Source 2: HOMERAIL_UI_PUBLIC_URL. A changed effective Origin restarts
    // both live listeners and the new Origin is the one enforced.
    const flagPids = runtimePids(harness.home);
    const fromEnv = await runUiStart(harness, [], { HOMERAIL_UI_PUBLIC_URL: "https://env-origin.example.test" });
    expect(fromEnv.errors).toEqual([]);
    const envPids = runtimePids(harness.home);
    expect(envPids.https).not.toBe(flagPids.https);
    expect(envPids.http).not.toBe(flagPids.http);
    await waitForRuntimePidExit(flagPids.https);
    await waitForRuntimePidExit(flagPids.http);
    for (const protocol of ["https", "http"] as const) {
      const port = protocol === "https" ? harness.httpsPort : harness.httpPort;
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: "https://env-origin.example.test", "Sec-Fetch-Site": "same-origin" },
      })).status).toBe(200);
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: "https://ui.example.test", "Sec-Fetch-Site": "same-origin" },
      })).status).toBe(403);
    }

    // Source 3: stored ui.publicUrl. Same restart-and-apply behavior.
    fs.writeFileSync(
      path.join(harness.home, "config.json"),
      `${JSON.stringify({ ui: { publicUrl: "https://stored.example.test" } }, null, 2)}\n`,
    );
    const fromConfig = await runUiStart(harness, []);
    expect(fromConfig.errors).toEqual([]);
    const configPids = runtimePids(harness.home);
    expect(configPids.https).not.toBe(envPids.https);
    expect(configPids.http).not.toBe(envPids.http);
    await waitForRuntimePidExit(envPids.https);
    await waitForRuntimePidExit(envPids.http);
    expect(runtimeStateFile(harness.home, "ui-https")?.explicitPublicUrl).toBe("https://stored.example.test");
    expect(runtimeStateFile(harness.home, "ui")?.explicitPublicUrl).toBe("https://stored.example.test");
    for (const protocol of ["https", "http"] as const) {
      const port = protocol === "https" ? harness.httpsPort : harness.httpPort;
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: "https://stored.example.test", "Sec-Fetch-Site": "same-origin" },
      })).status).toBe(200);
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: "https://env-origin.example.test", "Sec-Fetch-Site": "same-origin" },
      })).status).toBe(403);
    }
  }, 120_000);

  it("restarts stale live UI processes when the explicit Origin is added, changed, or removed; keeps unchanged Origins stable", async () => {
    const harness = await createRuntimeHarness();
    const originA = "https://origin-a.example.test";
    const originB = "https://origin-b.example.test";
    const httpSelfOrigin = `http://127.0.0.1:${harness.httpPort}`;
    const httpsSelfOrigin = `https://127.0.0.1:${harness.httpsPort}`;

    // Baseline: no explicit Origin anywhere -> strict request-derived
    // authorization on both listeners.
    const baseline = await runUiStart(harness, []);
    expect(baseline.errors).toEqual([]);
    expect(baseline.status.uiHttpsPidRunning).toBe(true);
    expect(baseline.status.uiHttpPidRunning).toBe(true);
    expect(runtimeStateFile(harness.home, "ui-https")?.explicitPublicUrl).toBeUndefined();
    expect(runtimeStateFile(harness.home, "ui")?.explicitPublicUrl).toBeUndefined();
    const baselinePids = runtimePids(harness.home);
    expect((await mutationRequest({
      protocol: "http",
      port: harness.httpPort,
      headers: { Origin: originA, "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(403);
    expect((await mutationRequest({
      protocol: "http",
      port: harness.httpPort,
      headers: { Origin: httpSelfOrigin, "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(200);

    // undefined -> value: both stale listeners are restarted and the new
    // Origin is enforced; status reports the processes actually running.
    const added = await runUiStart(harness, ["--public-url", originA]);
    expect(added.errors).toEqual([]);
    const addedPids = runtimePids(harness.home);
    expect(addedPids.https).not.toBe(baselinePids.https);
    expect(addedPids.http).not.toBe(baselinePids.http);
    await waitForRuntimePidExit(baselinePids.https);
    await waitForRuntimePidExit(baselinePids.http);
    expect(pidAlive(addedPids.https)).toBe(true);
    expect(pidAlive(addedPids.http)).toBe(true);
    expect(added.status.uiHttpsPid).toBe(addedPids.https);
    expect(added.status.uiHttpPid).toBe(addedPids.http);
    expect(runtimeStateFile(harness.home, "ui-https")?.explicitPublicUrl).toBe(originA);
    expect(runtimeStateFile(harness.home, "ui")?.explicitPublicUrl).toBe(originA);
    for (const protocol of ["https", "http"] as const) {
      const port = protocol === "https" ? harness.httpsPort : harness.httpPort;
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: originA, "Sec-Fetch-Site": "same-origin" },
      })).status).toBe(200);
    }

    // value -> identical value: healthy processes are not restarted.
    const unchanged = await runUiStart(harness, ["--public-url", originA]);
    expect(unchanged.errors).toEqual([]);
    const unchangedPids = runtimePids(harness.home);
    expect(unchangedPids).toEqual(addedPids);
    expect(unchanged.status.uiHttpsPid).toBe(addedPids.https);
    expect(unchanged.status.uiHttpPid).toBe(addedPids.http);

    // value -> different value: both listeners restart; the old Origin is
    // rejected after relaunch.
    const changed = await runUiStart(harness, ["--public-url", originB]);
    expect(changed.errors).toEqual([]);
    const changedPids = runtimePids(harness.home);
    expect(changedPids.https).not.toBe(addedPids.https);
    expect(changedPids.http).not.toBe(addedPids.http);
    await waitForRuntimePidExit(addedPids.https);
    await waitForRuntimePidExit(addedPids.http);
    expect(runtimeStateFile(harness.home, "ui-https")?.explicitPublicUrl).toBe(originB);
    expect(runtimeStateFile(harness.home, "ui")?.explicitPublicUrl).toBe(originB);
    for (const protocol of ["https", "http"] as const) {
      const port = protocol === "https" ? harness.httpsPort : harness.httpPort;
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: originA, "Sec-Fetch-Site": "same-origin" },
      })).status).toBe(403);
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: originB, "Sec-Fetch-Site": "same-origin" },
      })).status).toBe(200);
    }

    // value -> undefined: both listeners restart and strict request-derived
    // authorization is restored.
    const removed = await runUiStart(harness, []);
    expect(removed.errors).toEqual([]);
    const removedPids = runtimePids(harness.home);
    expect(removedPids.https).not.toBe(changedPids.https);
    expect(removedPids.http).not.toBe(changedPids.http);
    await waitForRuntimePidExit(changedPids.https);
    await waitForRuntimePidExit(changedPids.http);
    expect(runtimeStateFile(harness.home, "ui-https")?.explicitPublicUrl).toBeUndefined();
    expect(runtimeStateFile(harness.home, "ui")?.explicitPublicUrl).toBeUndefined();
    for (const protocol of ["https", "http"] as const) {
      const port = protocol === "https" ? harness.httpsPort : harness.httpPort;
      expect((await mutationRequest({
        protocol,
        port,
        headers: { Origin: originB, "Sec-Fetch-Site": "same-origin" },
      })).status).toBe(403);
    }
    expect((await mutationRequest({
      protocol: "http",
      port: harness.httpPort,
      headers: { Origin: httpSelfOrigin, "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(200);
    expect((await mutationRequest({
      protocol: "https",
      port: harness.httpsPort,
      headers: { Origin: httpsSelfOrigin, "Sec-Fetch-Site": "same-origin" },
    })).status).toBe(200);
  }, 120_000);

  it("restarts packaged UI processes whose recorded static root is stale", async () => {
    const harness = await createRuntimeHarness();
    const initial = await runUiStart(harness, []);
    expect(initial.errors).toEqual([]);
    const initialPids = runtimePids(harness.home);

    // Reproduce an AppImage relaunch: the detached children are alive, but
    // their state points to the previous extraction directory.
    for (const name of ["ui-https", "ui"] as const) {
      const statePath = path.join(harness.home, "pids", `${name}.json`);
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
      state.staticUiDir = path.join(harness.home, "missing-old-appimage", "agent-ui", "dist");
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    }

    const restarted = await runUiStart(harness, []);
    expect(restarted.errors).toEqual([]);
    const restartedPids = runtimePids(harness.home);
    expect(restartedPids.https).not.toBe(initialPids.https);
    expect(restartedPids.http).not.toBe(initialPids.http);
    await waitForRuntimePidExit(initialPids.https);
    await waitForRuntimePidExit(initialPids.http);
    expect(runtimeStateFile(harness.home, "ui-https")?.staticUiDir)
      .toBe(path.join(harness.repoRoot, "agent-ui", "dist"));
    expect(runtimeStateFile(harness.home, "ui")?.staticUiDir)
      .toBe(path.join(harness.repoRoot, "agent-ui", "dist"));

    // A subsequent start from the same package keeps healthy listeners.
    const unchanged = await runUiStart(harness, []);
    expect(unchanged.errors).toEqual([]);
    expect(runtimePids(harness.home)).toEqual(restartedPids);
  }, 120_000);
});

interface RuntimeHarness {
  home: string;
  repoRoot: string;
  managerUrl: string;
  httpsPort: number;
  httpPort: number;
  received: Array<{
    origin?: string;
    authorization?: string;
    mutationToken?: string;
    method?: string;
    path?: string;
  }>;
}

interface RuntimeUiStartStatus {
  uiPid?: number;
  uiHttpsPid?: number;
  uiHttpPid?: number;
  uiPidRunning: boolean;
  uiHttpsPidRunning: boolean;
  uiHttpPidRunning: boolean;
  uiHttpsPublicUrl?: string;
  uiHttpPublicUrl?: string;
}

const runtimeHarnesses: RuntimeHarness[] = [];
let sharedRuntimeRepoRoot: string | undefined;

const runtimeEnvKeys = [
  "HOMERAIL_HOME",
  "HOMERAIL_REPO_ROOT",
  "HOMERAIL_CONFIG_PATH",
  "HOMERAIL_SECRETS_PATH",
  "HOMERAIL_MANAGER_URL",
  "HOMERAIL_MANAGER_PUBLIC_URL",
  "HOMERAIL_UI_PORT",
  "HOMERAIL_UI_HTTP_PORT",
  "HOMERAIL_UI_PUBLIC_URL",
  "HOMERAIL_UI_SERVE_STATIC",
] as const;

/**
 * Hermetic repository root standing in for the real workspace: a prebuilt
 * static UI server (bundled from the real `src/static-ui-server.ts`) plus the
 * minimal agent-ui dist layout `startUiServer` expects. This lets the tests
 * drive the actual `hr ui start` runtime lifecycle — flag parsing, Origin
 * normalization, child environment propagation, persisted state, and restart
 * decisions — instead of launching `static-ui-server.ts` with hand-injected
 * environment variables.
 */
function runtimeRepoRoot(): string {
  if (sharedRuntimeRepoRoot) return sharedRuntimeRepoRoot;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-runtime-origin-repo-"));
  fs.mkdirSync(path.join(root, "agent-ui", "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "agent-ui", "package.json"),
    `${JSON.stringify({ name: "agent-ui", private: true }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(root, "agent-ui", "dist", "index.html"),
    "<!doctype html><title>runtime-origin-test</title>",
  );
  fs.mkdirSync(path.join(root, "homerail_cli", "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "homerail_cli", "package.json"),
    `${JSON.stringify({ name: "homerail-cli-runtime-test", private: true, type: "module" }, null, 2)}\n`,
  );
  buildSync({
    entryPoints: [path.resolve("src/static-ui-server.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: path.join(root, "homerail_cli", "dist", "static-ui-server.js"),
  });
  sharedRuntimeRepoRoot = root;
  return root;
}

async function createRuntimeHarness(): Promise<RuntimeHarness> {
  const repoRoot = runtimeRepoRoot();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-runtime-origin-home-"));
  tempDirs.push(home);
  const received: RuntimeHarness["received"] = [];
  const manager = http.createServer((req, res) => {
    received.push({
      origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      mutationToken: typeof req.headers["x-homerail-dag-token"] === "string"
        ? req.headers["x-homerail-dag-token"]
        : undefined,
      method: req.method,
      path: req.url,
    });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });
  servers.push(manager);
  const managerUrl = await listen(manager, "127.0.0.1");
  const httpsPort = await reservePort();
  const httpPort = await reservePort();
  const harness = { home, repoRoot, managerUrl, httpsPort, httpPort, received };
  runtimeHarnesses.push(harness);
  return harness;
}

async function runUiStart(
  harness: RuntimeHarness,
  extraArgs: string[],
  env: Record<string, string> = {},
): Promise<{ status: RuntimeUiStartStatus; errors: string[] }> {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of runtimeEnvKeys) savedEnv[key] = process.env[key];
  for (const key of runtimeEnvKeys) delete process.env[key];
  process.env.HOMERAIL_HOME = harness.home;
  process.env.HOMERAIL_REPO_ROOT = harness.repoRoot;
  process.env.HOMERAIL_UI_HTTP_PORT = String(harness.httpPort);
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((message) => {
    logs.push(String(message));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((message) => {
    errors.push(String(message));
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "homerail",
      "--json",
      "--base-url",
      harness.managerUrl,
      "ui",
      "start",
      "--port",
      String(harness.httpsPort),
      ...extraArgs,
    ]);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    for (const key of runtimeEnvKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    process.exitCode = previousExitCode;
  }
  const statusLine = logs.find((line) => line.startsWith("{"));
  if (!statusLine) {
    throw new Error(`hr ui start did not report status: ${errors.join("; ") || "unknown error"}`);
  }
  return { status: JSON.parse(statusLine) as RuntimeUiStartStatus, errors };
}

function runtimePidFile(home: string, name: "ui" | "ui-https"): number | undefined {
  try {
    const pid = Number(fs.readFileSync(path.join(home, "pids", `${name}.pid`), "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function runtimeStateFile(
  home: string,
  name: "ui" | "ui-https",
): { pid?: number; explicitPublicUrl?: string; staticUiDir?: string } | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "pids", `${name}.json`), "utf-8")) as {
      pid?: number;
      explicitPublicUrl?: string;
      staticUiDir?: string;
    };
  } catch {
    return undefined;
  }
}

function runtimePids(home: string): { https?: number; http?: number } {
  return { https: runtimePidFile(home, "ui-https"), http: runtimePidFile(home, "ui") };
}

function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForRuntimePidExit(pid: number | undefined, timeoutMs = 10_000): Promise<void> {
  if (pid === undefined) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Agent UI pid ${pid} did not exit within ${timeoutMs}ms`);
}

function mutationRequest(options: {
  protocol: "http" | "https";
  port: number;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const request = options.protocol === "https" ? https.request : http.request;
    const req = request({
      hostname: "127.0.0.1",
      port: options.port,
      method: options.method ?? "POST",
      path: options.path ?? "/api/runs",
      headers: options.headers,
      rejectUnauthorized: false,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.setTimeout(10_000, () => req.destroy(new Error("mutation request timed out")));
    req.on("error", reject);
    req.end();
  });
}

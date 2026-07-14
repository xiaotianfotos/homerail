import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TOKEN = "static-proxy-admin-token-0123456789abcdef";
const children: ChildProcess[] = [];
const servers: http.Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("static Agent UI mutation proxy", () => {
  it("rejects no-Origin/cross-origin requests and injects only for exact local self-Origin", async () => {
    const received: Array<{ authorization?: string; origin?: string; method?: string }> = [];
    const manager = http.createServer((req, res) => {
      received.push({
        authorization: req.headers.authorization,
        origin: req.headers.origin,
        method: req.method,
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
    });

    expect((await fetch(`${uiOrigin}/api/runs`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    })).status).toBe(403);
    expect(received).toHaveLength(0);

    expect((await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: uiOrigin },
    })).status).toBe(200);
    expect(received[0]).toEqual({
      authorization: `Bearer ${TOKEN}`,
      origin: uiOrigin,
      method: "POST",
    });

    expect((await fetch(`${uiOrigin}/api/read`)).status).toBe(200);
    expect(received[1]?.authorization).toBeUndefined();
  }, 15_000);

  it("fails a plaintext publicly bound mutation proxy closed even if the switch is forced on", async () => {
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
    await startStaticUi({ port: uiPort, host: "0.0.0.0", origin: uiOrigin, managerUrl });

    const response = await fetch(`${uiOrigin}/api/runs`, {
      method: "POST",
      headers: { Origin: uiOrigin },
    });
    expect(response.status).toBe(403);
    expect(managerHits).toBe(0);
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
}): Promise<void> {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "homerail-static-ui-trust-"));
  if (!options.root) {
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>test</title>");
  }
  const tsxCli = path.resolve("node_modules/tsx/dist/cli.mjs");
  const script = path.resolve("src/static-ui-server.ts");
  const child = spawn(process.execPath, [tsxCli, script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOMERAIL_STATIC_UI_DIR: root,
      HOMERAIL_UI_PORT: String(options.port),
      HOMERAIL_UI_HOST: options.host,
      HOMERAIL_UI_HTTPS: "0",
      HOMERAIL_MANAGER_HTTP: options.managerUrl,
      HOMERAIL_MANAGER_WS: options.managerUrl.replace(/^http/, "ws"),
      HOMERAIL_UI_ORIGIN: options.origin,
      HOMERAIL_UI_ADMIN_PROXY_ENABLED: "1",
      HOMERAIL_MANAGER_ADMIN_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stderr = "";
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

async function listen(server: http.Server, host: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return `http://${host}:${address.port}`;
}

async function reservePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("static UI did not become ready");
}

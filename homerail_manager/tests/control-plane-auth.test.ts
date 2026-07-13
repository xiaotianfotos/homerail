import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  isControlPlaneUpgradeAuthorized,
  isLoopbackRemoteAddress,
} from "../src/server/control-plane-auth.js";
import {
  createServer,
  mergeProvisionerOptions,
  resolveProvisionedWorkerRuntimeEnv,
  resolveWorkerControlPlaneAuth,
} from "../src/server/http.js";
import { setupNodeWebSocket } from "../src/node/websocket.js";
import { _clearNodes } from "../src/node/registry.js";
import { setupWorkerWebSocket } from "../src/worker/websocket.js";
import { _clearWorkers, getWorker } from "../src/worker/registry.js";
import {
  controlPlaneTokenPath,
  readOrCreateControlPlaneToken,
} from "../src/persistence/control-plane-secret.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeDb } from "../src/persistence/db.js";
import { WsClient } from "../../homerail_worker/src/ws-client.js";

async function listen(server: http.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("server did not bind");
  return address.port;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function upgradeStatus(url: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, token
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timed out waiting for websocket upgrade"));
    }, 1_000);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve(101);
    });
    ws.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    ws.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

describe("control-plane websocket authentication", () => {
  let oldHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    oldHome = process.env.HOMERAIL_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "homerail-control-plane-auth-"));
    process.env.HOMERAIL_HOME = tmpHome;
    closeDb();
  });

  afterEach(() => {
    _clearNodes();
    _clearWorkers();
    closeDb();
    if (oldHome === undefined) delete process.env.HOMERAIL_HOME;
    else process.env.HOMERAIL_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("allows loopback without a configured token and requires bearer auth remotely", () => {
    expect(isLoopbackRemoteAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isControlPlaneUpgradeAuthorized({
      remoteAddress: "127.0.0.1",
      authorization: undefined,
    })).toBe(true);
    expect(isControlPlaneUpgradeAuthorized({
      remoteAddress: "192.0.2.20",
      authorization: undefined,
    })).toBe(false);
    expect(isControlPlaneUpgradeAuthorized({
      remoteAddress: "192.0.2.20",
      authorization: "Bearer wrong",
      configuredToken: "secret",
    })).toBe(false);
    expect(isControlPlaneUpgradeAuthorized({
      remoteAddress: "192.0.2.20",
      authorization: "Bearer secret",
      configuredToken: "secret",
    })).toBe(true);
  });

  it("requires configured credentials even on loopback unless explicitly exempted", () => {
    expect(isControlPlaneUpgradeAuthorized({
      remoteAddress: "127.0.0.1",
      authorization: undefined,
      configuredToken: "secret",
    })).toBe(false);
    expect(isControlPlaneUpgradeAuthorized({
      remoteAddress: "127.0.0.1",
      authorization: undefined,
      configuredToken: "secret",
      allowLoopbackWithoutToken: true,
    })).toBe(true);
  });

  it("enforces worker and node tokens before accepting the websocket upgrade", async () => {
    const server = http.createServer();
    setupWorkerWebSocket(server, {
      authToken: "worker-secret",
      allowLoopbackWithoutToken: false,
    });
    setupNodeWebSocket(server, {
      authToken: "node-secret",
      allowLoopbackWithoutToken: false,
    });
    const port = await listen(server);

    try {
      const workerUrl = `ws://127.0.0.1:${port}/ws/projects/p1/workers/w1`;
      const nodeUrl = `ws://127.0.0.1:${port}/ws/projects/p1/nodes/n1`;
      await expect(upgradeStatus(workerUrl)).resolves.toBe(401);
      await expect(upgradeStatus(workerUrl, "wrong")).resolves.toBe(401);
      await expect(upgradeStatus(workerUrl, "worker-secret")).resolves.toBe(101);
      await expect(upgradeStatus(nodeUrl)).resolves.toBe(401);
      await expect(upgradeStatus(nodeUrl, "wrong")).resolves.toBe(401);
      await expect(upgradeStatus(nodeUrl, "node-secret")).resolves.toBe(101);
    } finally {
      await closeServer(server);
    }
  });

  it("uses configured tokens or generates a provision token", () => {
    expect(resolveWorkerControlPlaneAuth({
      HOMERAIL_WORKER_TOKEN: " configured-token ",
    }, () => "unused")).toEqual({
      token: "configured-token",
      explicitlyConfigured: true,
    });
    const generated = resolveWorkerControlPlaneAuth({}, () => "generated-token");
    expect(generated).toEqual({
      token: "generated-token",
      explicitlyConfigured: false,
    });
    expect(resolveProvisionedWorkerRuntimeEnv(generated, {
      CLAUDE_MAX_TURNS: "8",
      ANTHROPIC_API_KEY: "must-not-propagate",
    })).toEqual({
      CLAUDE_MAX_TURNS: "8",
      HOMERAIL_WORKER_TOKEN: "generated-token",
    });
  });

  it("persists the generated provision token across Manager restarts", () => {
    expect(readOrCreateControlPlaneToken(() => "persisted-token")).toBe("persisted-token");
    expect(readOrCreateControlPlaneToken(() => "must-not-rotate")).toBe("persisted-token");
    expect(fs.readFileSync(controlPlaneTokenPath(), "utf8").trim()).toBe("persisted-token");
    if (process.platform !== "win32") {
      expect(fs.statSync(controlPlaneTokenPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves control-plane defaults when provisioner options are customized", () => {
    const managerWorkerWsBaseUrl = () => "ws://host.docker.internal:23456";
    const merged = mergeProvisionerOptions({
      provisioner: {
        image: "default-worker",
        extraHosts: ["host.docker.internal:host-gateway"],
        env: { CLAUDE_MAX_TURNS: "8", HOMERAIL_WORKER_TOKEN: "default-token" },
      },
      managerBaseUrl: "http://127.0.0.1:23456",
      managerWorkerWsBaseUrl,
      projectId: "p1",
    }, {
      provisioner: {
        image: "custom-worker",
        env: { CUSTOM_RUNTIME_FLAG: "1", HOMERAIL_WORKER_TOKEN: "stale-token" },
      },
    }, "effective-token");

    expect(merged.managerWorkerWsBaseUrl).toBe(managerWorkerWsBaseUrl);
    expect(merged.projectId).toBe("p1");
    expect(merged.provisioner).toMatchObject({
      image: "custom-worker",
      extraHosts: ["host.docker.internal:host-gateway"],
      env: {
        CLAUDE_MAX_TURNS: "8",
        CUSTOM_RUNTIME_FLAG: "1",
        HOMERAIL_WORKER_TOKEN: "effective-token",
      },
    });
  });

  it("reuses the persisted token when a worker reconnects after Manager restart", async () => {
    let server = createServer(0, undefined, undefined, false);
    const port = await listen(server);
    const token = fs.readFileSync(controlPlaneTokenPath(), "utf8").trim();
    const workerId = "restart-auth-worker";
    const client = new WsClient({
      url: `ws://127.0.0.1:${port}/ws/projects/p1/workers/${workerId}`,
      workerId,
      token,
      reconnectBaseMs: 25,
      reconnectMaxMs: 50,
    });
    client.on("error", () => undefined);

    try {
      client.connect();
      await waitFor(() => getWorker(workerId)?.socket.readyState === WebSocket.OPEN);

      getWorker(workerId)?.socket.terminate();
      await waitFor(() => getWorker(workerId) === undefined);
      await closeServer(server);

      server = createServer(port, undefined, undefined, false);
      await listen(server, port);
      await waitFor(() => getWorker(workerId)?.socket.readyState === WebSocket.OPEN);
      expect(fs.readFileSync(controlPlaneTokenPath(), "utf8").trim()).toBe(token);
    } finally {
      client.close();
      getWorker(workerId)?.socket.terminate();
      await closeServer(server);
    }
  });
});
